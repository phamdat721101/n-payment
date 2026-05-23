/**
 * n-payment v0.15 — Flare FXRP direct-minting bridge demo.
 *
 * Subcommands:
 *   registry              — resolve AssetManagerFXRP / MasterAccountController / MintingTagManager addresses
 *   state-lookup          — print PersonalAccount, FXRP balance, vaults, agent vaults
 *   quote <amountXrp>     — compute fees + gross XRP for a given net mint amount
 *   memo <evmAddress>     — render the 32-byte direct-minting memo as XRPL hex
 *   mint <amountXrp>      — submit an XRPL Payment to the Core Vault and return the receipt
 *
 * Required env:
 *   XRPL_SEED       XRPL secret seed (sEd…) — fund via https://xrpl.org/resources/dev-tools/xrp-faucets
 *   FLARE_RPC_URL   (optional) override Coston2 RPC URL
 */
import {
  XrplConnection,
  XrplWallet,
  createFlareClient,
  FlareBridgeClient,
  getPersonalAccountAddress,
  getFxrpBalance,
  getFxrpDecimals,
  getOperatorXrplAddresses,
  getVaults,
  getAgentVaults,
  computeDirectMintingQuote,
  getDirectMintingFees,
  encodeDirectMintingMemo32,
  toXrplMemoHex,
} from '../src/index.js';

const SEED = process.env.XRPL_SEED;
const RPC = process.env.FLARE_RPC_URL;

function requireSeed(): string {
  if (!SEED) {
    console.error('[demo] Set XRPL_SEED to a funded testnet seed. Faucet: https://xrpl.org/resources/dev-tools/xrp-faucets');
    process.exit(1);
  }
  return SEED;
}

async function cmdRegistry(): Promise<void> {
  const flare = createFlareClient({ rpcUrl: RPC });
  const [assetManager, masterAccountController, mintingTagManager] = await Promise.all([
    flare.registry.address('AssetManagerFXRP'),
    flare.registry.address('MasterAccountController'),
    flare.registry.address('MintingTagManager').catch((e) => `(unavailable: ${(e as Error).message})`),
  ]);
  console.log(JSON.stringify({ assetManager, masterAccountController, mintingTagManager }, null, 2));
}

async function cmdStateLookup(): Promise<void> {
  const wallet = new XrplWallet({ seed: requireSeed() });
  const xrplAddress = await wallet.getAddress();
  const flare = createFlareClient({ rpcUrl: RPC });

  const [personalAccount, operators, vaults, agentVaults] = await Promise.all([
    getPersonalAccountAddress(flare, xrplAddress),
    getOperatorXrplAddresses(flare),
    getVaults(flare),
    getAgentVaults(flare),
  ]);
  const [fxrpBalance, fxrpDecimals] = await Promise.all([
    getFxrpBalance(flare, personalAccount),
    getFxrpDecimals(flare),
  ]);

  console.log(JSON.stringify({
    xrplAddress,
    personalAccount,
    operators,
    fxrpBalance: fxrpBalance.toString(),
    fxrpDecimals,
    vaults: vaults.map((v) => ({ ...v, id: v.id.toString() })),
    agentVaults: agentVaults.map((v) => ({ ...v, id: v.id.toString() })),
  }, null, 2));
}

async function cmdQuote(amountXrp: string): Promise<void> {
  const flare = createFlareClient({ rpcUrl: RPC });
  const fees = await getDirectMintingFees(flare);
  const quote = computeDirectMintingQuote(amountXrp, fees);
  console.log(JSON.stringify({
    netFxrp: quote.netFxrp,
    paymentXrp: quote.paymentXrp,
    fees: {
      feeBips: fees.feeBips.toString(),
      proportionalUBA: quote.proportionalFeeUBA.toString(),
      minFeeUBA: fees.minFeeUBA.toString(),
      executorFeeUBA: fees.executorFeeUBA.toString(),
      mintingFeeUBA: quote.mintingFeeUBA.toString(),
    },
  }, null, 2));
}

async function cmdMemo(addr: string): Promise<void> {
  const memo = toXrplMemoHex(encodeDirectMintingMemo32(addr as `0x${string}`));
  console.log(memo);
}

async function cmdMint(amountXrp: string): Promise<void> {
  const seed = requireSeed();
  const wallet = new XrplWallet({ seed });
  const connection = new XrplConnection('xrpl-testnet');
  const flare = createFlareClient({ rpcUrl: RPC });
  const bridge = new FlareBridgeClient({ flare, xrplConnection: connection, xrplWallet: wallet });

  const start = Date.now();
  const receipt = await bridge.mintFXRP({ amountXrp });
  console.log(JSON.stringify({
    elapsedMs: Date.now() - start,
    xrplTxHash: receipt.xrplTxHash,
    xrplValidated: receipt.xrplValidated,
    paymentXrp: receipt.paymentXrp,
    netFxrp: receipt.netFxrp,
    recipientPersonalAccount: receipt.recipientPersonalAccount,
    coreVaultXrplAddress: receipt.coreVaultXrplAddress,
    rateLimitLarge: receipt.rateLimit.large,
    fees: {
      proportionalUBA: receipt.fees.proportionalUBA.toString(),
      minFeeUBA: receipt.fees.minFeeUBA.toString(),
      mintingFeeUBA: receipt.fees.mintingFeeUBA.toString(),
      executorFeeUBA: receipt.fees.executorFeeUBA.toString(),
    },
  }, null, 2));
  await connection.disconnect();
  console.log(
    `\nPoll FXRP balance with: pnpm tsx examples/flare-bridge-demo.ts state-lookup`,
  );
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'registry': return cmdRegistry();
    case 'state-lookup': return cmdStateLookup();
    case 'quote':
      if (!arg) throw new Error('quote requires <amountXrp>');
      return cmdQuote(arg);
    case 'memo':
      if (!arg) throw new Error('memo requires <evmAddress>');
      return cmdMemo(arg);
    case 'mint':
      if (!arg) throw new Error('mint requires <amountXrp>');
      return cmdMint(arg);
    default:
      console.error('usage: flare-bridge-demo <registry|state-lookup|quote|memo|mint> [arg]');
      process.exit(1);
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
