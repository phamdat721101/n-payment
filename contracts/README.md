# n-payment contracts (Foundry)

Solidity contracts for `n-payment`'s DeFi vault strategy (v0.31.0). Isolated
from the TS/Vitest build — `npm test` / `npm run build` at the repo root
never touch this directory.

## Setup

`lib/` (forge-std, OpenZeppelin) is gitignored — vendored dependencies are
never committed as plain files. On a fresh clone, restore them with:

```bash
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
```

No `npm install` step is required for this directory.

## Commands

```bash
forge build                                    # compile contracts
forge test                                     # unit tests only (NOTE: AutonomousDeFiAllocationVaultForkTest
                                                #   requires forked state and WILL fail here — see below)
FORK_RPC_URL=<rpc> forge test --fork-url mainnet_fork   # fork tests (Task 14) — the real test run
```

`npm run test:contracts` (plain `forge test`, no fork) is expected to show
`AutonomousDeFiAllocationVaultForkTest` failing — that suite calls real
Morpho Blue / Aave v3 / Balancer V2 contracts that only exist when running
against forked mainnet state. Use `npm run test:contracts:fork` (or the
`FORK_RPC_URL=... forge test --fork-url mainnet_fork` command above) for
the real, meaningful test run of that suite.

If `FORK_RPC_URL` is not set, `mainnet_fork` cannot resolve (Foundry's
`foundry.toml` does not support shell-style `${VAR:-default}` fallbacks —
`${FORK_RPC_URL}` must be a real, set environment variable). No dedicated
RPC keys are provisioned yet (see root `docs/v031` plan notes) — point it
at any public endpoint, e.g. `https://ethereum-rpc.publicnode.com`.
Fork tests make real read calls against forked mainnet state; **no test in
this suite deploys to or transacts on a live network.**

## Scope

- `src/AutonomousDeFiAllocationVault.sol` — real ERC-4626 meta-vault (Task 14).
  Real, callable Tier 1 (Aave v3) <-> Tier 2 (Morpho Blue) instant-unbonding
  waterfall (`instantWithdrawForPayment`), real direct rebalance functions,
  and a real Balancer V2 (array-based, NOT ERC-3156) atomic flash-loan
  callback (`executeAtomicRebalance` / `receiveFlashLoan`). Tier 3 (Pendle
  PT) integration is intentionally exposed only via a generic
  `executeArbitraryCall()` escape hatch — see the contract's own header
  comment for why. **Not deployed anywhere** — fork-tested only, per plan
  requirement #5.
- `test/AutonomousDeFiAllocationVault.t.sol` — 6 fork tests against real
  Ethereum mainnet state (real Morpho Blue idle USDC market, real Aave v3
  Pool, real Balancer V2 Vault): Tier-1-only instant payment, Tier-2
  flash-unwind-into-payment, PayRouter/owner access-control guards, and a
  real end-to-end Balancer V2 flash-loan round trip (flash-borrow ->
  Aave supply -> Aave withdraw via `type(uint256).max` -> repay). Run with:
  ```bash
  FORK_RPC_URL=https://ethereum-rpc.publicnode.com forge test --fork-url mainnet_fork -vv
  ```
