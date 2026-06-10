/**
 * v0.25 — Celo Mento corridor demo (cKES → USDC via USDm).
 *
 *   pnpm tsx examples/celo-mento-demo.ts <amount-cKES>
 *
 * Demonstrates the v0.25 Mento corridor primitive: an agent on Celo Mainnet
 * holding cKES (Kenyan-shilling stablecoin) wants to settle a USDC paywall.
 * The corridor walks two legs (cKES → USDm → USDC) via Mento's on-chain
 * Broker, with each swap fee-abstracted via CIP-64 (no CELO needed).
 *
 * Required env:
 *   CELO_PRIVATE_KEY    — hex-encoded wallet key funded with cKES on Celo Mainnet
 *   MENTO_EXCHANGE_KES  — exchangeId bytes32 for the cKES↔USDm pool
 *   MENTO_EXCHANGE_USDM — exchangeId bytes32 for the USDm↔USDC pool
 *   MENTO_PROVIDER      — Mento exchange-provider address (BiPoolManager)
 */
import {
  CeloFeeAbstractedTransactor,
  MentoBrokerClient,
  MENTO_ASSETS,
  selectMentoCorridor,
} from '../src/celo/index.js';
import type { Hex, Address } from 'viem';

const PRIV = process.env.CELO_PRIVATE_KEY as Hex | undefined;
const PROVIDER = process.env.MENTO_PROVIDER as Address | undefined;
const EX_KES = process.env.MENTO_EXCHANGE_KES as Hex | undefined;
const EX_USDM = process.env.MENTO_EXCHANGE_USDM as Hex | undefined;

if (!PRIV || !PROVIDER || !EX_KES || !EX_USDM) {
  console.error('Required env: CELO_PRIVATE_KEY, MENTO_PROVIDER, MENTO_EXCHANGE_KES, MENTO_EXCHANGE_USDM');
  process.exit(1);
}

const cKesHumanAmount = Number(process.argv[2] ?? '100');
const amountIn = BigInt(Math.floor(cKesHumanAmount * 1e18));
const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as const;

(async () => {
  const broker = new MentoBrokerClient('celo-mainnet', {
    resolveExchange: (tokenIn) => {
      // cKES on the source side → use the cKES↔USDm exchangeId; otherwise
      // assume USDm↔USDC exchangeId. Production integrators should swap in
      // a registry-backed resolver instead.
      const isFirstLeg = tokenIn.toLowerCase() === MENTO_ASSETS.cKES.address.toLowerCase();
      return { provider: PROVIDER, exchangeId: isFirstLeg ? EX_KES : EX_USDM };
    },
  });

  console.log(`→ Quoting cKES ${cKesHumanAmount} → USDC via Mento`);
  const decision = await selectMentoCorridor({
    assetIn: 'cKES',
    assetOut: 'USDC',
    amountIn,
    broker,
    maxSlippageBps: 100, // 1%
  });

  if (decision.kind === 'no-route') {
    console.error(`No route: ${decision.reason}`);
    process.exit(2);
  }
  console.log(`Decision   : ${decision.kind}`);
  console.log(`Legs       : ${decision.legs.length}`);
  for (const leg of decision.legs) {
    console.log(`  ${leg.assetIn} → ${leg.assetOut} : in=${leg.amountIn} out=${leg.expectedOut}`);
  }
  console.log(`Slippage   : ${decision.slippageBps} bps`);
  console.log(`Final out  : ${decision.expectedOut} USDC (atomic units)`);

  // Execute the swap legs sequentially, each CIP-64 wrapped.
  const transactor = new CeloFeeAbstractedTransactor(PRIV!, 'celo-mainnet', 'USDm');
  for (const leg of decision.legs) {
    const tokenIn  = leg.assetIn  === 'USDC' ? USDC : MENTO_ASSETS[leg.assetIn].address;
    const tokenOut = leg.assetOut === 'USDC' ? USDC : MENTO_ASSETS[leg.assetOut].address;
    const minOut = (leg.expectedOut * 99n) / 100n; // 1% slippage tolerance
    console.log(`→ swapIn(${leg.assetIn} → ${leg.assetOut}) amount=${leg.amountIn}`);
    const r = await broker.swapIn(transactor, tokenIn, tokenOut, leg.amountIn, minOut);
    console.log(`  txHash: ${r.txHash} (block ${r.blockNumber})`);
  }
  console.log('Done. Settle the resulting USDC against the merchant via fetchWithPayment.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
