/**
 * v0.22.1 — Unified XRPFi corridor demo.
 *
 * Three modes:
 *   --mode=forward — XRP-on-XRPL → FXRP-on-Flare via FlareBridgeClient.mintFXRP.
 *                    Stops at FXRP (Flare not in NTT-RLUSD registry; v0.23 closes).
 *   --mode=reverse — FXRP-on-Flare → XRP-on-XRPL → RLUSD-on-XRPL via FlareBridgeClient.redeemXRP
 *                    + pollRedemption + XrplSwapClient.swap.
 *   --mode=auto    — corridor decision via selectRlusdCorridor; logs the decision,
 *                    runs the matching path.
 *
 * Env:
 *   FLARE_NETWORK             flare-mainnet | songbird-mainnet | coston2-testnet
 *   FLARE_PRIVATE_KEY         signer for redeem (writeContract)
 *   XRPL_SEED                 sEd... wallet seed
 *   XRPL_DESTINATION          r... XRPL address to receive XRP on redeem
 *   AMOUNT_XRP                decimal string (default '1')
 *   AMOUNT_RLUSD              decimal string (default '0.5')
 *
 * Usage:
 *   pnpm tsx examples/xrpfi-roundtrip-demo.ts --mode=auto
 */
import 'dotenv/config';
import {
  createFlareClient,
  FlareBridgeClient,
  XrplConnection,
  XrplWallet,
  XrplSwapClient,
  selectRlusdCorridor,
  RLUSD_ISSUERS,
  networkFromChainKey,
} from '../src/index.js';

interface Args {
  mode: 'forward' | 'reverse' | 'auto';
  amountXrp: string;
  amountRlusd: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = a.indexOf(flag);
    if (i >= 0) return a[i + 1];
    const eq = a.find((x) => x.startsWith(flag + '='));
    if (eq) return eq.split('=')[1];
    return fallback;
  };
  return {
    mode: (get('--mode', 'auto') ?? 'auto') as Args['mode'],
    amountXrp: process.env.AMOUNT_XRP ?? '1',
    amountRlusd: process.env.AMOUNT_RLUSD ?? '0.5',
  };
}

const log = (label: string, msg: string, t0: number) =>
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}: ${msg}`);

async function runForward(t0: number, args: Args) {
  console.log('🪙 XRPFi forward — XRP → FXRP (stops at Flare; v0.23 closes the loop)');

  const flare = createFlareClient({ network: process.env.FLARE_NETWORK as never });
  const xrplSeed = process.env.XRPL_SEED;
  if (!xrplSeed) {
    console.warn('⚠️ XRPL_SEED missing — config-only mode');
    return;
  }
  const xrplWallet = new XrplWallet({ seed: xrplSeed });
  const xrplConnection = new XrplConnection('xrpl-mainnet');

  const bridge = new FlareBridgeClient({ flare, xrplWallet, xrplConnection });
  log('mint', `mintFXRP(${args.amountXrp} XRP)`, t0);
  const receipt = await bridge.mintFXRP({ amountXrp: args.amountXrp });
  log('mint', `XRPL tx: ${receipt.xrplTxHash}`, t0);
  log('mint', `PersonalAccount: ${receipt.recipientPersonalAccount}`, t0);
  log('mint', `Net FXRP: ${receipt.netFxrp} (executor will land mint event in 30-90s)`, t0);
  console.log(
    '\nℹ️  forward path stops here. Full RLUSD-on-EVM closure requires Flare in the NTT-RLUSD registry (v0.23).',
  );
}

async function runReverse(t0: number, args: Args) {
  console.log('🪙 XRPFi reverse — FXRP → XRP → RLUSD on XRPL');

  const flarePk = process.env.FLARE_PRIVATE_KEY;
  const xrplSeed = process.env.XRPL_SEED;
  const xrplDestination = process.env.XRPL_DESTINATION;
  if (!flarePk || !xrplSeed || !xrplDestination) {
    console.warn('⚠️  FLARE_PRIVATE_KEY / XRPL_SEED / XRPL_DESTINATION missing — config-only mode');
    return;
  }

  // Ethers-side viem wallet (lazy peer-dep)
  const flare = createFlareClient({ network: process.env.FLARE_NETWORK as never });
  const { createWalletClient, http } = (await import('viem')) as typeof import('viem');
  const { privateKeyToAccount } = (await import('viem/accounts')) as typeof import('viem/accounts');
  const account = privateKeyToAccount(flarePk as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: flare.publicClient.chain,
    transport: http(),
  });

  const xrplWallet = new XrplWallet({ seed: xrplSeed });
  const xrplConnection = new XrplConnection('xrpl-mainnet');
  const bridge = new FlareBridgeClient({
    flare,
    xrplWallet,
    xrplConnection,
    walletClient: walletClient as never,
    flareAddress: account.address,
  });

  log('redeem', `redeemXRP(${args.amountXrp} FXRP) → ${xrplDestination}`, t0);
  const redeemReceipt = await bridge.redeemXRP({
    amountFxrp: args.amountXrp,
    xrplDestination,
  });
  log('redeem', `requestId=${redeemReceipt.requestId}, flareTx=${redeemReceipt.flareTxHash}`, t0);

  log('poll', 'awaiting executor (10-min timeout)...', t0);
  const performed = await bridge.pollRedemption(redeemReceipt.requestId, {
    timeoutMs: 600_000,
    intervalMs: 5_000,
  });
  log('poll', `XRPL Payment confirmed: ${performed.xrplTxHash}`, t0);

  // Now swap XRP → RLUSD on XRPL
  const network = networkFromChainKey('xrpl-mainnet');
  const issuer = RLUSD_ISSUERS[network];
  const swap = new XrplSwapClient(xrplConnection, xrplWallet, network, issuer);
  log('swap', `swap(XRP → RLUSD ${args.amountRlusd}) on XRPL`, t0);
  const swapResult = await swap.swap({
    from: 'XRP',
    to: 'RLUSD',
    amountOut: args.amountRlusd,
    maxSlippageBps: 100,
  });
  log('swap', `XRPL swap tx: ${swapResult.hash}`, t0);
  console.log(`\n✅ RLUSD-XRPL delivered: ${swapResult.amountOut} RLUSD`);
}

async function runAuto(t0: number, args: Args) {
  console.log('🪙 XRPFi auto — corridor decides');
  // Probe: pretend the merchant wants RLUSD-XRPL and we hold FXRP.
  const decision = selectRlusdCorridor({
    requestedAsset: 'RLUSD',
    requestedChain: 'xrpl-mainnet',
    requestedAmount: BigInt(Math.floor(parseFloat(args.amountXrp) * 1e18)),
    buyerHoldings: {},
    flareHoldings: { fxrp: 100n * 10n ** 18n },
    allowXrpfi: true,
  });
  log('corridor', `decision=${decision.kind}`, t0);
  console.log(JSON.stringify(decision, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

  if (decision.kind === 'xrpfi-redeem-then-swap') {
    await runReverse(t0, args);
  } else if (decision.kind === 'xrpfi-mint-fxrp') {
    await runForward(t0, args);
  } else {
    console.log('   (no XRPFi path triggered for this fixture — try --mode=forward or --mode=reverse)');
  }
}

async function main() {
  const t0 = Date.now();
  const args = parseArgs();
  console.log(`🚀 n-payment v0.22.1 — XRPFi corridor demo (mode=${args.mode})`);
  if (args.mode === 'forward') await runForward(t0, args);
  else if (args.mode === 'reverse') await runReverse(t0, args);
  else await runAuto(t0, args);
  console.log(`\n⏱️  total: ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('❌ demo failed:', err);
  process.exit(1);
});
