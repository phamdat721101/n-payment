# Tests

Two-tier suite, mirroring the `RUN_LIVE_XRPL_TESTS` convention used
elsewhere in this project's ecosystem for exactly this kind of live-network
gating.

## Default suite — fully offline, deterministic

```bash
npm test              # vitest run — all *.test.ts except live-gated files
```

Every test file runs with mocked/fixture data. No network calls. This is
what CI should run on every commit.

Live-gated test files use `describe.runIf(process.env.RUN_LIVE_ONCHAIN_TESTS === 'true')`
so they show as **skipped** (not failed) in the default run.

## Live-gated suite — real on-chain reads

```bash
npm run test:live-onchain    # RUN_LIVE_ONCHAIN_TESTS=true vitest run
```

Currently gates `tests/research-adapters-live.test.ts` — real, read-only
RPC calls against public Ethereum mainnet endpoints (default
`https://ethereum-rpc.publicnode.com`, overridable via
`RESEARCH_RPC_URL_ETHEREUM`) proving all 5 `OnchainLendingResearchService`
protocol adapters (Morpho Blue, Aave v3, Pendle, Euler v2, Silo v2) work
against real, currently-live contract state. No credentials required
(read-only calls only); no transactions are ever sent.

Run this manually before releasing changes to any `src/research/adapters/*`
file, and whenever a cited "real" address/market/vault needs re-verifying
(protocols occasionally deprecate markets or rotate factory addresses).

## Solidity contract tests (Foundry)

See `contracts/README.md` — a separate, isolated Foundry project
(`contracts/`) with its own unit tests (`forge test`) and fork tests
against real forked Ethereum mainnet state (`npm run test:contracts:fork`).
Never touched by `npm test`.
