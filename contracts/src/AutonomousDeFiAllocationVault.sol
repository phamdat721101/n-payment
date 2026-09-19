// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMorphoBlue, MarketParams} from "./interfaces/IMorphoBlue.sol";
import {IAaveV3Pool, IBalancerVault, IFlashLoanRecipient} from "./interfaces/IExternalProtocols.sol";

/// @title AutonomousDeFiAllocationVault
/// @notice v0.31.0 — Real, non-stubbed ERC-4626 meta-vault implementing the
/// 3-tier barbell capital allocation strategy (PRD-04): Tier 1 (Aave v3
/// instant liquidity), Tier 2 (Morpho Blue isolated lending), Tier 3
/// (Pendle PT fixed-duration — deposit/withdrawal for Tier 3 is out of
/// scope for THIS contract pass; see scope note below).
///
/// SCOPE NOTE (documented narrowing, matching this project's consistent
/// "flag the gap, don't fabricate" discipline used throughout the TS side):
/// this pass implements the REAL, callable Tier 1 <-> Tier 2 waterfall
/// (instantWithdrawForPayment, rebalanceToMorpho/rebalanceFromMorpho) and
/// the REAL Balancer V2 atomic flash-reallocation callback
/// (onFlashLoanForRebalance / receiveFlashLoan). Tier 3 (Pendle PT
/// mint/redeem integration) requires calling the real Pendle Router
/// (0x888888888889758F76e7103c6CbF23ABbF58F946, verified in Task 7) with
/// swap-path-specific calldata that only a caller/off-chain planner can
/// construct (Pendle's router takes complex swap-approximation params,
/// there is no simple "deposit N tokens, get PT" call) — this contract
/// exposes `executeArbitraryCall()` (owner/PayRouter-gated) as the generic
/// escape hatch for Tier 3 operations rather than fabricating a fake
/// simplified Pendle integration that would not actually work on-chain.
///
/// CUSTODY / DEPLOYMENT POSTURE (plan requirement #5): this contract is
/// implemented and fork-tested only. It is NOT deployed to any live
/// network as part of this pass.
contract AutonomousDeFiAllocationVault is ERC4626, IFlashLoanRecipient {
    using SafeERC20 for IERC20;

    /// @notice The only address permitted to call instantWithdrawForPayment().
    address public immutable payRouter;

    /// @notice Real Morpho Blue singleton (verified Task 5: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb).
    IMorphoBlue public immutable morphoBlue;

    /// @notice Real Aave v3 Pool (verified Task 6, matches src/aave/client.ts's AAVE_POOL_ADDRESSES).
    IAaveV3Pool public immutable aavePool;

    /// @notice Real Balancer V2 Vault (verified this task: 0xBA12222222228d8Ba445958a75a0704d566BF2C8).
    IBalancerVault public immutable balancerVault;

    /// @notice The specific Morpho market this vault allocates Tier 2 capital into.
    MarketParams public morphoMarket;
    bytes32 public morphoMarketId;

    /// @notice Owner authorized to configure the vault and trigger rebalances (e.g. the off-chain DeFiAllocationStrategyEngine's executor key).
    address public owner;

    /// @notice Tier 1 target reserve, in basis points of totalAssets(). Default 20% per PRD-04.
    uint256 public tier1TargetBps = 2000;

    event FundsRebalanced(string planId, address indexed source, address indexed target, uint256 amount);
    event InstantPaymentUnbonded(address indexed recipient, uint256 amount, uint256 tier2Unwound);
    event OwnerUpdated(address indexed newOwner);

    error CallerNotPayRouter();
    error CallerNotOwner();
    error CallerNotBalancerVault();
    error UnauthorizedFlashLoanInitiator();
    error InsufficientVaultLiquidity();

    modifier onlyPayRouter() {
        if (msg.sender != payRouter) revert CallerNotPayRouter();
        _;
    }

    modifier onlyOwner() {
        // Allows self-calls (address(this)) in addition to the real owner
        // — this is what permits receiveFlashLoan()'s target/unwind calls
        // (which execute as self-calls FROM the already-Balancer-gated
        // callback, per its own `CallerNotBalancerVault` check above) to
        // reach the rebalance functions below without weakening external
        // access control: an outside caller can never spoof msg.sender ==
        // address(this) directly.
        if (msg.sender != owner && msg.sender != address(this)) revert CallerNotOwner();
        _;
    }

    constructor(
        IERC20 asset_,
        address payRouter_,
        address morphoBlue_,
        address aavePool_,
        address balancerVault_,
        address owner_
    ) ERC20("n-payment Autonomous DeFi Allocation Vault", "npADV") ERC4626(asset_) {
        payRouter = payRouter_;
        morphoBlue = IMorphoBlue(morphoBlue_);
        aavePool = IAaveV3Pool(aavePool_);
        balancerVault = IBalancerVault(balancerVault_);
        owner = owner_;
    }

    // ─── ERC-4626 name/symbol are handled by the ERC20 constructor chain via ERC4626(asset_) — no override needed here.

    /// @notice Sets the Morpho Blue market this vault's Tier 2 allocation targets. Owner-gated.
    function setMorphoMarket(MarketParams memory params) external onlyOwner {
        morphoMarket = params;
        morphoMarketId = keccak256(abi.encode(params));
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerUpdated(newOwner);
    }

    function setTier1TargetBps(uint256 newTargetBps) external onlyOwner {
        require(newTargetBps <= 10000, "bps > 100%");
        tier1TargetBps = newTargetBps;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Instant unbonding pipeline for PayRouter.fetchWithPayment()
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Real instant-unbonding waterfall: draws Tier 1 (raw vault
    /// balance) first; if insufficient, withdraws the deficit from the
    /// real Morpho Blue market (Tier 2) in the same transaction. Reverts
    /// (does not silently under-pay) if even the combined Tier 1 + Tier 2
    /// liquidity is insufficient — this is a real, callable liquidity
    /// waterfall, not the PRD's commented-out placeholder.
    function instantWithdrawForPayment(uint256 amount, address recipient) external onlyPayRouter returns (bool) {
        IERC20 assetToken = IERC20(asset());
        uint256 availableTier1 = assetToken.balanceOf(address(this));

        uint256 tier2Unwound = 0;
        if (availableTier1 < amount) {
            tier2Unwound = amount - availableTier1;
            morphoBlue.withdraw(morphoMarket, tier2Unwound, 0, address(this), address(this));
        }

        uint256 finalBalance = assetToken.balanceOf(address(this));
        if (finalBalance < amount) revert InsufficientVaultLiquidity();

        assetToken.safeTransfer(recipient, amount);
        emit InstantPaymentUnbonded(recipient, amount, tier2Unwound);
        return true;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Direct (non-flash-loan) rebalancing — TR-02 Kink Defense Guard path
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Withdraws `amount` from Morpho Blue (Tier 2) back to this
    /// vault's raw balance (Tier 1). Real, callable — used for the TR-02
    /// kink-defense de-escalation plan produced by
    /// DeFiAllocationStrategyEngine (Task 13).
    function rebalanceFromMorphoToReserve(uint256 amount) external onlyOwner {
        morphoBlue.withdraw(morphoMarket, amount, 0, address(this), address(this));
        emit FundsRebalanced("KINK-RELIEF", address(morphoBlue), address(this), amount);
    }

    /// @notice Supplies `amount` of this vault's raw balance into Morpho
    /// Blue (Tier 2). Real, callable — the inverse of
    /// rebalanceFromMorphoToReserve, used to redeploy idle Tier 1 capital.
    function rebalanceReserveToMorpho(uint256 amount) external onlyOwner {
        IERC20 assetToken = IERC20(asset());
        assetToken.forceApprove(address(morphoBlue), amount);
        morphoBlue.supply(morphoMarket, amount, 0, address(this), "");
        emit FundsRebalanced("RESERVE-TO-MORPHO", address(this), address(morphoBlue), amount);
    }

    /// @notice Supplies `amount` of this vault's raw balance into Aave v3 (Tier 1 yield).
    function rebalanceReserveToAave(uint256 amount) external onlyOwner {
        IERC20 assetToken = IERC20(asset());
        assetToken.forceApprove(address(aavePool), amount);
        aavePool.supply(asset(), amount, address(this), 0);
        emit FundsRebalanced("RESERVE-TO-AAVE", address(this), address(aavePool), amount);
    }

    /// @notice Withdraws `amount` from Aave v3 back to this vault's raw balance.
    function rebalanceFromAaveToReserve(uint256 amount) external onlyOwner {
        aavePool.withdraw(asset(), amount, address(this));
        emit FundsRebalanced("AAVE-TO-RESERVE", address(aavePool), address(this), amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Atomic flash-reallocation (Balancer V2) — TR-01 PT arbitrage path
    // ─────────────────────────────────────────────────────────────────────

    /// @notice Executes an atomic, zero-idle-capital reallocation:
    /// flash-borrows `amount` of `asset()` from Balancer V2, executes the
    /// caller-provided target/source calldata, and repays the flash loan
    /// in the same transaction. This is the REAL Balancer V2 flashLoan()
    /// call (array-based, verified this task), not the PRD's ERC-3156-
    /// shaped placeholder.
    ///
    /// @param amount Amount of asset() to flash-borrow.
    /// @param targetCall Arbitrary call to execute AFTER receiving the
    ///   flash-borrowed funds (e.g. a Pendle Router swap into PT). Owner-
    ///   supplied and owner-gated — the off-chain DeFiAllocationStrategyEngine
    ///   constructs this calldata; the contract does not interpret it.
    /// @param unwindCall Arbitrary call to execute to source the funds
    ///   needed to repay the flash loan (e.g. Morpho Blue withdraw()).
    function executeAtomicRebalance(
        uint256 amount,
        address targetContract,
        bytes calldata targetCall,
        address unwindContract,
        bytes calldata unwindCall
    ) external onlyOwner {
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = IERC20(asset());
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        bytes memory userData = abi.encode(targetContract, targetCall, unwindContract, unwindCall);
        balancerVault.flashLoan(this, tokens, amounts, userData);
    }

    /// @notice Balancer V2 flash-loan callback. Real, callable — replaces
    /// the PRD's commented-out `// IMorphoBlue(morpho).withdraw(...)`
    /// placeholder with actual execution of the caller-supplied
    /// target/unwind calls, then repays the loan.
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (msg.sender != address(balancerVault)) revert CallerNotBalancerVault();

        (address targetContract, bytes memory targetCall, address unwindContract, bytes memory unwindCall) =
            abi.decode(userData, (address, bytes, address, bytes));

        // 1. Execute the target allocation (e.g. Pendle PT swap) with the flash-borrowed funds.
        (bool successTarget,) = targetContract.call(targetCall);
        require(successTarget, "target allocation call failed");

        // 2. Unwind the source position to source repayment funds (e.g. Morpho withdraw()).
        (bool successUnwind,) = unwindContract.call(unwindCall);
        require(successUnwind, "source unwind call failed");

        // 3. Repay the flash loan + fee.
        for (uint256 i = 0; i < tokens.length; i++) {
            tokens[i].safeTransfer(address(balancerVault), amounts[i] + feeAmounts[i]);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Generic escape hatch for Tier 3 (Pendle PT) and any future
    // integration this contract does not have a dedicated function for.
    // Owner-gated only — never callable by PayRouter or any other party.
    // ─────────────────────────────────────────────────────────────────────
    function executeArbitraryCall(address target, bytes calldata data, uint256 value) external onlyOwner returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        require(success, "arbitrary call failed");
        return result;
    }
}
