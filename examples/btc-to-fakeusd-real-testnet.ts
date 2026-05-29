/**
 * REAL on-chain swap on GOAT Testnet3 (chainId 48816).
 *
 * Path: native BTC (gas)  →  wrap to WBTC  →  swap WBTC→FakeUSD via OKU/Uniswap V3
 *
 * Why not USDC? GOAT testnet3 has no live WGBTC↔USDC pool. The active DEX uses
 * a different "WBTC" wrapper (0xee4bc4…) instead of the canonical WGBTC at
 * 0xbC10…. The single liquid pool involving that wrapper is WBTC↔FakeUSD
 * (a 6-dec USD-like test token) at 0.3% fee. We swap into FakeUSD as the
 * stablecoin destination since it's the only pool with real on-chain liquidity.
 *
 * Discovered live testnet contracts (via Blockscout + RPC probes):
 *   SwapRouter02 = 0xaE663b6a9Da7179Ec80b248ab0b84410128017ff
 *   Factory      = 0xd31686e65f17542c7019b22b2e6a0c71e72aa8dd
 *   WBTC (wrap)  = 0xee4bc42157cf65291ba2fe839ae127e3cc76f741   (18 dec, name "Wrapped Bitcoin (Native)")
 *   FakeUSD      = 0x37375d3a50e9b9938f62f0bf5f021d7aa5444706   (6 dec, "FakeUSD")
 *   Pool 0.3%    = 0x14B58774C83A3E43A32e5a25ff8aD4fEf467fea0   (token0=FakeUSD, token1=WBTC)
 *
 * Run:  npx tsx examples/btc-to-fakeusd-real-testnet.ts            # full flow
 *       npx tsx examples/btc-to-fakeusd-real-testnet.ts --quote    # quote only
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
  encodeFunctionData,
  parseEther,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL = 'https://rpc.testnet3.goat.network';
const CHAIN_ID = 48816;

const WBTC: Address = '0xee4bc42157cf65291ba2fe839ae127e3cc76f741';
const FAKE_USD: Address = '0x37375d3a50e9b9938f62f0bf5f021d7aa5444706';
const SWAP_ROUTER: Address = '0xaE663b6a9Da7179Ec80b248ab0b84410128017ff';
const POOL: Address = '0x14B58774C83A3E43A32e5a25ff8aD4fEf467fea0';
const FEE_TIER = 3000; // 0.30%

// 0.000003 BTC — leaves headroom for gas (we have 0.00001 native BTC).
const AMOUNT_TO_WRAP_AND_SWAP = 3_000_000_000_000n; // 3e12 wei

const goatTestnet3 = defineChain({
  id: CHAIN_ID,
  name: 'GOAT Testnet3',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// ─── ABIs ────────────────────────────────────────────────────────────────────

const WBTC_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const POOL_ABI = [
  {
    type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

const SWAP_ROUTER_ABI = [
  {
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

// ─── Pretty ──────────────────────────────────────────────────────────────────

const hr = (label = '') =>
  console.log(label ? `\n══ ${label} ${'═'.repeat(Math.max(0, 70 - label.length))}` : '─'.repeat(72));
const fmt18 = (wei: bigint) => `${formatUnits(wei, 18)} BTC`;
const fmt6 = (wei: bigint) => `${formatUnits(wei, 6)} FakeUSD`;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const quoteOnly = process.argv.includes('--quote');
  const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex | undefined;
  if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith('0x') || PRIVATE_KEY.length !== 66) {
    console.error('\nERROR: PRIVATE_KEY env var is required (0x-prefixed 64-hex EVM key).');
    console.error('Example:  PRIVATE_KEY=0x... npx tsx examples/btc-to-fakeusd-real-testnet.ts');
    process.exit(2);
  }

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: goatTestnet3, transport: http() });
  const walletClient = createWalletClient({ chain: goatTestnet3, transport: http(), account });

  hr('🐐 GOAT Testnet3 — real wrap + swap (native BTC → WBTC → FakeUSD)');
  console.log(`Chain        : goat-testnet3 (chainId 48816)`);
  console.log(`Wallet       : ${account.address}`);
  console.log(`Router       : ${SWAP_ROUTER}`);
  console.log(`Pool         : ${POOL} (WBTC/FakeUSD, 0.30% fee)`);

  // ── 1. Initial state ────────────────────────────────────────────────────
  hr('1. Initial wallet state');
  const [nativeBefore, wbtcBefore, fusdBefore, gasPrice, blockNumber] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: WBTC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    publicClient.readContract({ address: FAKE_USD, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    publicClient.getGasPrice(),
    publicClient.getBlockNumber(),
  ]);
  console.log(`Block        : ${blockNumber}`);
  console.log(`Gas price    : ${gasPrice} wei  (${(Number(gasPrice) / 1e9).toFixed(6)} gwei)`);
  console.log(`Native BTC   : ${fmt18(nativeBefore)}  (${nativeBefore} wei)`);
  console.log(`WBTC         : ${formatUnits(wbtcBefore, 18)}`);
  console.log(`FakeUSD      : ${fmt6(fusdBefore)}`);

  if (nativeBefore < AMOUNT_TO_WRAP_AND_SWAP + 1_000_000_000n) {
    console.log(`\n⚠️  Insufficient native BTC. Need at least ${AMOUNT_TO_WRAP_AND_SWAP + 1_000_000_000n} wei.`);
    console.log(`    Top up at: https://bridge.testnet3.goat.network/faucet`);
    console.log(`    Address  : ${account.address}`);
    return;
  }

  // ── 2. Pool state + minOut estimate ─────────────────────────────────────
  hr('2. Pool state & minOut estimate');
  const slot0 = await publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: 'slot0' }) as readonly [bigint, number, number, number, number, number, boolean];
  const sqrtPriceX96 = slot0[0];
  const tick = slot0[1];
  console.log(`sqrtPriceX96 : ${sqrtPriceX96}`);
  console.log(`tick         : ${tick}`);

  // pool: token0=FakeUSD(6), token1=WBTC(18)
  // price1per0 = (sqrtPriceX96/2^96)^2  → WBTC-wei per FakeUSD-wei
  // We want: FakeUSD_out = WBTC_in / price1per0  (then scale by decimals)
  const Q96 = 2n ** 96n;
  // Use float for the estimate (we cap with 50% slippage minOut anyway)
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  const price1per0 = sqrtPrice * sqrtPrice; // WBTC-wei per FakeUSD-wei
  const fusdOutEstimateF = Number(AMOUNT_TO_WRAP_AND_SWAP) / price1per0; // FakeUSD wei
  const fusdOutEstimate = BigInt(Math.floor(fusdOutEstimateF));
  console.log(`Estimate     : ${fmt18(AMOUNT_TO_WRAP_AND_SWAP)} → ~${fmt6(fusdOutEstimate)}  (mid-price)`);
  // 50% slippage cap — testnet pools are thin; this is a demo
  const amountOutMinimum = (fusdOutEstimate * 50n) / 100n;
  console.log(`amountOutMin : ${amountOutMinimum}  (50% slippage cap, demo only)`);

  if (quoteOnly) {
    hr('Quote-only mode — exiting before any tx');
    return;
  }

  // ── 3. Wrap native → WBTC ───────────────────────────────────────────────
  hr('3. Tx 1/3 — wrap native BTC → WBTC (deposit)');
  const wrapData = encodeFunctionData({ abi: WBTC_ABI, functionName: 'deposit' });
  const wrapHash = await walletClient.sendTransaction({
    to: WBTC,
    value: AMOUNT_TO_WRAP_AND_SWAP,
    data: wrapData,
  });
  console.log(`tx           : ${wrapHash}`);
  console.log(`explorer     : https://explorer.testnet3.goat.network/tx/${wrapHash}`);
  const wrapReceipt = await publicClient.waitForTransactionReceipt({ hash: wrapHash });
  console.log(`status       : ${wrapReceipt.status}  (block ${wrapReceipt.blockNumber}, gas ${wrapReceipt.gasUsed})`);
  if (wrapReceipt.status !== 'success') throw new Error('wrap failed');

  // ── 4. Approve router ───────────────────────────────────────────────────
  hr('4. Tx 2/3 — approve SwapRouter02 for WBTC');
  const approveData = encodeFunctionData({
    abi: WBTC_ABI, functionName: 'approve',
    args: [SWAP_ROUTER, AMOUNT_TO_WRAP_AND_SWAP],
  });
  const approveHash = await walletClient.sendTransaction({ to: WBTC, data: approveData });
  console.log(`tx           : ${approveHash}`);
  console.log(`explorer     : https://explorer.testnet3.goat.network/tx/${approveHash}`);
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`status       : ${approveReceipt.status}  (block ${approveReceipt.blockNumber}, gas ${approveReceipt.gasUsed})`);
  if (approveReceipt.status !== 'success') throw new Error('approve failed');

  // ── 5. Swap WBTC → FakeUSD ──────────────────────────────────────────────
  hr('5. Tx 3/3 — swap WBTC → FakeUSD via SwapRouter02.exactInputSingle');
  const swapData = encodeFunctionData({
    abi: SWAP_ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{
      tokenIn: WBTC,
      tokenOut: FAKE_USD,
      fee: FEE_TIER,
      recipient: account.address,
      amountIn: AMOUNT_TO_WRAP_AND_SWAP,
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    }],
  });
  const swapHash = await walletClient.sendTransaction({ to: SWAP_ROUTER, data: swapData });
  console.log(`tx           : ${swapHash}`);
  console.log(`explorer     : https://explorer.testnet3.goat.network/tx/${swapHash}`);
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
  console.log(`status       : ${swapReceipt.status}  (block ${swapReceipt.blockNumber}, gas ${swapReceipt.gasUsed})`);

  // ── 6. Final state ──────────────────────────────────────────────────────
  hr('6. Final wallet state');
  const [nativeAfter, wbtcAfter, fusdAfter] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: WBTC, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    publicClient.readContract({ address: FAKE_USD, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
  ]);
  console.log(`Native BTC   : ${fmt18(nativeAfter)}      Δ = ${fmt18(nativeAfter - nativeBefore)}`);
  console.log(`WBTC         : ${formatUnits(wbtcAfter, 18)}      Δ = ${formatUnits(wbtcAfter - wbtcBefore, 18)}`);
  console.log(`FakeUSD      : ${fmt6(fusdAfter)}      Δ = ${fmt6(fusdAfter - fusdBefore)}`);

  hr('Done');
  console.log(`Effective rate: 1 BTC ≈ ${(Number(fusdAfter - fusdBefore) / 1e6) / (Number(AMOUNT_TO_WRAP_AND_SWAP) / 1e18)} FakeUSD`);
}

main().catch((err) => {
  console.error('\nFATAL:', err.shortMessage ?? err.message ?? err);
  if (err.cause) console.error('cause:', err.cause);
  process.exit(1);
});
