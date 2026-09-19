// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal Aave v3 Pool interface slice actually used by this vault.
/// Verified against aave.com/docs/aave-v3/smart-contracts/pool during
/// implementation of the TypeScript research adapter
/// (src/research/adapters/aave.ts) — reused here for the Solidity side.
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @notice Real Balancer V2 Vault flash-loan interface. Verified against
/// balancer/docs's reference/contracts/flash-loans.md during
/// implementation — NOT ERC-3156-compliant (uses array-based multi-token
/// calls, not a single-token onFlashLoan callback), correcting the
/// original PRD-04 sketch, which assumed an ERC-3156-shaped
/// `onFlashLoan(initiator, token, amount, fee, data)` callback that does
/// not match Balancer V2's real interface.
interface IBalancerVault {
    function flashLoan(
        IFlashLoanRecipient recipient,
        IERC20[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

interface IFlashLoanRecipient {
    function receiveFlashLoan(
        IERC20[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

/// @dev Real, verified mainnet address (balancer/docs, ethereum.stackexchange
/// confirmation, multiple independent sources during implementation).
address constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
