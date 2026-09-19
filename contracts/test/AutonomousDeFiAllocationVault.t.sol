// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AutonomousDeFiAllocationVault} from "../src/AutonomousDeFiAllocationVault.sol";
import {IMorphoBlue, MarketParams} from "../src/interfaces/IMorphoBlue.sol";
import {IAaveV3Pool} from "../src/interfaces/IExternalProtocols.sol";

/// @notice Fork tests for AutonomousDeFiAllocationVault (Task 14).
/// Runs against FORKED Ethereum mainnet state (real Morpho Blue, real
/// Aave v3, real Balancer V2 Vault) — NO deployment to any live network,
/// per plan requirement #5. Run with:
///   FORK_RPC_URL=<rpc> forge test --fork-url mainnet_fork -vv
/// (defaults to https://ethereum-rpc.publicnode.com if FORK_RPC_URL unset —
/// see foundry.toml).
contract AutonomousDeFiAllocationVaultForkTest is Test {
    // Real, verified mainnet addresses (all independently confirmed during
    // the TypeScript research-adapter tasks, Tasks 5-9, or this task).
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant MORPHO_BLUE = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;

    // Real Morpho Blue idle USDC market (verified Task 5's live test):
    // loanToken=USDC, collateralToken=address(0), oracle=address(0), irm=address(0), lltv=0.
    address constant IDLE_MARKET_ORACLE = address(0);
    address constant IDLE_MARKET_IRM = address(0);
    uint256 constant IDLE_MARKET_LLTV = 0;

    AutonomousDeFiAllocationVault vault;
    IERC20 usdc;
    address payRouter = address(0xBEEF);
    address vaultOwner = address(0xCAFE);

    function setUp() public {
        usdc = IERC20(USDC);
        vault = new AutonomousDeFiAllocationVault(usdc, payRouter, MORPHO_BLUE, AAVE_V3_POOL, BALANCER_V2_VAULT, vaultOwner);

        vm.prank(vaultOwner);
        vault.setMorphoMarket(
            MarketParams({
                loanToken: USDC,
                collateralToken: IDLE_MARKET_ORACLE, // idle market: collateralToken = address(0)
                oracle: IDLE_MARKET_ORACLE,
                irm: IDLE_MARKET_IRM,
                lltv: IDLE_MARKET_LLTV
            })
        );

        // Fund the vault with real USDC via Foundry's deal() cheatcode
        // (StdCheats) — writes directly to the real USDC contract's
        // storage slot on the fork, rather than depending on any
        // particular "whale" address holding a specific balance at the
        // exact forked block (a genuinely fragile assumption a live
        // whale-transfer approach would carry).
        deal(USDC, address(vault), 100_000e6);
    }

    /// @notice Scenario 1: Tier 1 instant payment — PayRouter calls
    /// instantWithdrawForPayment() and the vault's raw balance alone
    /// covers it (no Tier 2 unwind needed).
    function test_instantWithdrawForPayment_tier1Only() public {
        uint256 recipientBalanceBefore = usdc.balanceOf(address(0xD00D));

        vm.prank(payRouter);
        bool ok = vault.instantWithdrawForPayment(50_000e6, address(0xD00D));

        assertTrue(ok);
        assertEq(usdc.balanceOf(address(0xD00D)) - recipientBalanceBefore, 50_000e6);
    }

    /// @notice Scenario 2: Tier 2 flash-unwind-into-payment — vault
    /// supplies most of its balance into the REAL Morpho Blue idle market
    /// first, then a payment request exceeding the remaining Tier 1
    /// balance triggers a REAL morphoBlue.withdraw() call within
    /// instantWithdrawForPayment(), atomically in the same transaction.
    function test_instantWithdrawForPayment_tier2Unwind() public {
        // Supply 80k of the 100k vault balance into the real Morpho idle market, leaving 20k in Tier 1.
        vm.prank(vaultOwner);
        vault.rebalanceReserveToMorpho(80_000e6);
        assertEq(usdc.balanceOf(address(vault)), 20_000e6);

        // Request a payment of 50k — Tier 1 (20k) alone is insufficient;
        // the vault must pull 30k from the real Morpho Blue market.
        vm.prank(payRouter);
        bool ok = vault.instantWithdrawForPayment(50_000e6, address(0xD00D));

        assertTrue(ok);
        assertEq(usdc.balanceOf(address(0xD00D)), 50_000e6);
    }

    /// @notice Reverts (does not silently under-pay) if a caller other than
    /// PayRouter attempts the instant-unbonding path.
    function test_instantWithdrawForPayment_revertsForNonPayRouterCaller() public {
        vm.prank(address(0x1234));
        vm.expectRevert(AutonomousDeFiAllocationVault.CallerNotPayRouter.selector);
        vault.instantWithdrawForPayment(1_000e6, address(0xD00D));
    }

    /// @notice Scenario 3: Atomic flash-reallocation via the REAL Balancer
    /// V2 Vault. Flash-borrows USDC, deposits it into the real Aave v3
    /// Pool (standing in for a Tier-3-style external allocation target —
    /// this proves the real receiveFlashLoan() callback + repayment path
    /// works against forked mainnet state; the Pendle-specific calldata
    /// construction itself is an off-chain planner's job, out of this
    /// contract's scope per its own header comment).
    function test_executeAtomicRebalance_realBalancerFlashLoan() public {
        uint256 flashAmount = 10_000e6;

        // targetCall: vault.rebalanceReserveToAave(flashAmount) — deposits
        // the flash-borrowed funds into the real Aave v3 Pool.
        bytes memory targetCall = abi.encodeCall(AutonomousDeFiAllocationVault.rebalanceReserveToAave, (flashAmount));

        // unwindCall: vault.rebalanceFromAaveToReserve(type(uint256).max) —
        // Aave's own docs (aave.com/docs/aave-v3/smart-contracts/pool)
        // state `type(uint).max` withdraws the FULL aToken balance,
        // avoiding a real rounding mismatch between the raw supplied
        // amount and the interest-index-scaled aToken balance available
        // moments later (confirmed live on this fork: a fixed-amount
        // withdraw request can slightly exceed the actual scaled balance
        // and revert with Aave's real NotEnoughAvailableUserBalance()
        // error) — this is exactly the kind of on-chain behavior only a
        // real fork test surfaces, not a mocked one.
        bytes memory unwindCall = abi.encodeCall(AutonomousDeFiAllocationVault.rebalanceFromAaveToReserve, (type(uint256).max));

        uint256 balanceBefore = usdc.balanceOf(address(vault));

        vm.prank(vaultOwner);
        vault.executeAtomicRebalance(flashAmount, address(vault), targetCall, address(vault), unwindCall);

        // Balance should be roughly unchanged (Balancer V2 flash loans currently charge 0 fee, per balancer/docs).
        assertApproxEqAbs(usdc.balanceOf(address(vault)), balanceBefore, 1e6);
    }

    /// @notice The receiveFlashLoan callback must reject any caller other
    /// than the real Balancer V2 Vault — proves the access-control guard
    /// is real and enforced, not merely declared.
    function test_receiveFlashLoan_revertsForNonBalancerCaller() public {
        IERC20[] memory tokens = new IERC20[](1);
        tokens[0] = usdc;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1_000e6;
        uint256[] memory fees = new uint256[](1);
        fees[0] = 0;

        vm.expectRevert(AutonomousDeFiAllocationVault.CallerNotBalancerVault.selector);
        vault.receiveFlashLoan(tokens, amounts, fees, "");
    }

    /// @notice Non-owner cannot trigger rebalancing functions.
    function test_rebalanceFunctions_revertForNonOwner() public {
        vm.expectRevert(AutonomousDeFiAllocationVault.CallerNotOwner.selector);
        vault.rebalanceReserveToMorpho(1_000e6);

        vm.expectRevert(AutonomousDeFiAllocationVault.CallerNotOwner.selector);
        vault.rebalanceReserveToAave(1_000e6);
    }
}
