import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAINS,
  FlareGaslessForwarderClient,
  FlareX402Adapter,
  PAYMENT_REQUEST_TYPES,
  buildFlareX402Challenge,
  createGaslessExecutor,
  decodeFlareX402Header,
  detectProtocol,
  verifyAndSettleFlareX402,
  type FlareX402Payload,
  type FlarePaymentRequest,
} from '../src/index.js';
import { OWSWallet } from '../src/index.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Deterministic test key (well-known anvil/hardhat key #0). NEVER use in prod.
const BUYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const FACILITATOR = '0x2222222222222222222222222222222222222222' as Address;
const FORWARDER = '0x3333333333333333333333333333333333333333' as Address;

const buyerAccount = privateKeyToAccount(BUYER_PK);

// ─── Chain config ────────────────────────────────────────────────────────────

describe('v0.19: chains', () => {
  it('registers all three Flare networks', () => {
    expect(CHAINS['flare-coston2-testnet'].chainId).toBe(114);
    expect(CHAINS['flare-songbird-mainnet'].chainId).toBe(19);
    expect(CHAINS['flare-mainnet'].chainId).toBe(14);
  });

  it('registers flare-x402 protocol on each Flare chain', () => {
    for (const k of ['flare-coston2-testnet', 'flare-songbird-mainnet', 'flare-mainnet'] as const) {
      expect(CHAINS[k].protocols).toContain('flare-x402');
    }
  });
});

// ─── detectProtocol routing ──────────────────────────────────────────────────

describe('v0.19: detectProtocol → flare-x402', () => {
  it('recognises flare-coston2 network in challenge envelope', () => {
    const challenge = Buffer.from(
      JSON.stringify({ accepts: [{ network: 'flare-coston2' }] }),
    ).toString('base64');
    const res = new Response(null, { status: 402, headers: { 'payment-required': challenge } });
    expect(detectProtocol(res)).toBe('flare-x402');
  });

  it('recognises eip155:114 / 19 / 14 CAIP-2 forms', () => {
    for (const network of ['eip155:114', 'eip155:19', 'eip155:14']) {
      const challenge = Buffer.from(JSON.stringify({ accepts: [{ network }] })).toString('base64');
      const res = new Response(null, { status: 402, headers: { 'payment-required': challenge } });
      expect(detectProtocol(res)).toBe('flare-x402');
    }
  });
});

// ─── FlareX402Adapter (buyer) ────────────────────────────────────────────────

describe('FlareX402Adapter', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  function makeAdapter() {
    const wallet = new OWSWallet({ wallet: 'flare-test', privateKey: BUYER_PK });
    // Stub balance so the adapter does not try to hit a real RPC.
    vi.spyOn(wallet, 'getBalance').mockResolvedValue(10_000_000n);
    return new FlareX402Adapter(wallet, 'flare-coston2-testnet');
  }

  it('signs an EIP-3009 authorization recoverable to the buyer (header challenge path)', async () => {
    const adapter = makeAdapter();
    const challenge = buildFlareX402Challenge({
      price: '100000',
      payTo: PAY_TO,
      asset: TOKEN,
      facilitatorAddress: FACILITATOR,
      network: 'flare-coston2',
      chainId: 114,
    });
    const initial = new Response(null, { status: 402, headers: { 'payment-required': challenge } });

    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const xPayment = (init.headers as Headers).get('x-payment')!;
      const decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString()) as FlareX402Payload;
      // 9 flat fields, exactly per Flare's docs spec.
      expect(decoded.from.toLowerCase()).toBe(buyerAccount.address.toLowerCase());
      expect(decoded.to).toBe(PAY_TO);
      expect(decoded.token).toBe(TOKEN);
      expect(decoded.value).toBe('100000');
      expect(typeof decoded.v).toBe('number');
      expect(decoded.r.length).toBe(66);
      expect(decoded.s.length).toBe(66);

      // Recover the signature: must equal the buyer's address.
      const sig = (`0x${decoded.r.slice(2)}${decoded.s.slice(2)}${decoded.v.toString(16).padStart(2, '0')}`) as Hex;
      const recovered = await recoverTypedDataAddress({
        domain: { name: 'Mock USDT0', version: '1', chainId: 114, verifyingContract: TOKEN },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: decoded.from,
          to: decoded.to,
          value: BigInt(decoded.value),
          validAfter: BigInt(decoded.validAfter),
          validBefore: BigInt(decoded.validBefore),
          nonce: decoded.nonce,
        },
        signature: sig,
      });
      expect(recovered.toLowerCase()).toBe(buyerAccount.address.toLowerCase());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as never;

    const result = await adapter.pay('https://example.com/api/x', undefined, initial);
    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to JSON body when payment-required header is absent (Flare reference shape)', async () => {
    const adapter = makeAdapter();
    const body = {
      x402Version: '1',
      accepts: [{
        scheme: 'exact',
        network: 'flare-coston2',
        maxAmountRequired: '100000',
        payTo: PAY_TO,
        asset: 'USDT0',
        extra: { tokenAddress: TOKEN, facilitatorAddress: FACILITATOR, chainId: 114 },
      }],
    };
    const initial = new Response(JSON.stringify(body), { status: 402 });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as never;

    await adapter.pay('https://example.com/api/x', undefined, initial);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws InsufficientBalanceError when balance < required', async () => {
    const wallet = new OWSWallet({ wallet: 'flare-test', privateKey: BUYER_PK });
    vi.spyOn(wallet, 'getBalance').mockResolvedValue(0n);
    const adapter = new FlareX402Adapter(wallet, 'flare-coston2-testnet');
    const challenge = buildFlareX402Challenge({
      price: '100000', payTo: PAY_TO, asset: TOKEN, facilitatorAddress: FACILITATOR,
    });
    const initial = new Response(null, { status: 402, headers: { 'payment-required': challenge } });
    await expect(adapter.pay('https://x.test', undefined, initial)).rejects.toThrow(/Insufficient/);
  });

  it('detect() returns true for any 402 (header or body) on its configured chain', () => {
    const adapter = makeAdapter();
    const headerless402 = new Response(null, { status: 402 });
    expect(adapter.detect(headerless402)).toBe(true);
    const bodyChallenge = buildFlareX402Challenge({
      price: '1', payTo: PAY_TO, asset: TOKEN, facilitatorAddress: FACILITATOR,
    });
    const withHeader = new Response(null, { status: 402, headers: { 'payment-required': bodyChallenge } });
    expect(adapter.detect(withHeader)).toBe(true);
    const non402 = new Response(null, { status: 200 });
    expect(adapter.detect(non402)).toBe(false);
  });
});

// ─── Merchant settle helper ──────────────────────────────────────────────────

describe('verifyAndSettleFlareX402', () => {
  function makeClients(opts: { valid: boolean; settleStatus?: 'success' | 'reverted' }) {
    const publicClient = {
      readContract: vi.fn(async () => ['0xpaymentid' as Hex, opts.valid] as const),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: opts.settleStatus ?? 'success',
        blockNumber: 1n,
        gasUsed: 100_000n,
      })),
    };
    const walletClient = {
      writeContract: vi.fn(async () => ('0xtxhash' as Hex)),
      account: { address: PAY_TO },
      chain: null,
    };
    return { publicClient, walletClient };
  }
  const samplePayload: FlareX402Payload = {
    from: buyerAccount.address, to: PAY_TO, token: TOKEN,
    value: '100000', validAfter: '0', validBefore: '99999999999',
    nonce: '0xa1' + '0'.repeat(62) as Hex,
    v: 27, r: '0x' + 'a'.repeat(64) as Hex, s: '0x' + 'b'.repeat(64) as Hex,
  };

  it('returns paymentId+txHash on happy path', async () => {
    const { publicClient, walletClient } = makeClients({ valid: true });
    const out = await verifyAndSettleFlareX402({
      publicClient: publicClient as never, walletClient: walletClient as never,
      facilitatorAddress: FACILITATOR, payload: samplePayload,
    });
    expect(out.paymentId).toBe('0xpaymentid');
    expect(out.transactionHash).toBe('0xtxhash');
    expect(out.settled).toBe(true);
    expect(walletClient.writeContract).toHaveBeenCalledOnce();
  });

  it('throws FLARE_X402_VERIFY_FAILED when verifyPayment returns false', async () => {
    const { publicClient, walletClient } = makeClients({ valid: false });
    await expect(
      verifyAndSettleFlareX402({
        publicClient: publicClient as never, walletClient: walletClient as never,
        facilitatorAddress: FACILITATOR, payload: samplePayload,
      }),
    ).rejects.toMatchObject({ code: 'FLARE_X402_VERIFY_FAILED' });
    expect(walletClient.writeContract).not.toHaveBeenCalled();
  });

  it('throws FLARE_X402_SETTLE_FAILED when settle receipt reverts', async () => {
    const { publicClient, walletClient } = makeClients({ valid: true, settleStatus: 'reverted' });
    await expect(
      verifyAndSettleFlareX402({
        publicClient: publicClient as never, walletClient: walletClient as never,
        facilitatorAddress: FACILITATOR, payload: samplePayload,
      }),
    ).rejects.toMatchObject({ code: 'FLARE_X402_SETTLE_FAILED' });
  });
});

// ─── Header decode + challenge build ─────────────────────────────────────────

describe('decodeFlareX402Header / buildFlareX402Challenge', () => {
  it('round-trips a payload', () => {
    const original: FlareX402Payload = {
      from: buyerAccount.address, to: PAY_TO, token: TOKEN,
      value: '100000', validAfter: '0', validBefore: '99999999999',
      nonce: ('0x' + 'c'.repeat(64)) as Hex,
      v: 28, r: ('0x' + '1'.repeat(64)) as Hex, s: ('0x' + '2'.repeat(64)) as Hex,
    };
    const encoded = Buffer.from(JSON.stringify(original)).toString('base64');
    expect(decodeFlareX402Header(encoded)).toEqual(original);
  });

  it('builds a base64 challenge consumable by FlareX402Adapter', () => {
    const challenge = buildFlareX402Challenge({
      price: '500000', payTo: PAY_TO, asset: TOKEN, facilitatorAddress: FACILITATOR,
      network: 'flare-coston2', chainId: 114,
    });
    const decoded = JSON.parse(Buffer.from(challenge, 'base64').toString());
    expect(decoded.accepts[0].maxAmountRequired).toBe('500000');
    expect(decoded.accepts[0].extra.tokenAddress).toBe(TOKEN);
  });
});

// ─── FlareGaslessForwarderClient + executor ──────────────────────────────────

describe('FlareGaslessForwarderClient', () => {
  function makeClient() {
    const publicClient = {
      readContract: vi.fn(async (args: any) => {
        if (args.functionName === 'fxrp') return '0xfxrp' as Address;
        if (args.functionName === 'decimals') return 6;
        if (args.functionName === 'balanceOf') return 1_000_000n;
        if (args.functionName === 'allowance') return 0n;
        if (args.functionName === 'getNonce') return 7n;
        return 0n;
      }),
      getChainId: vi.fn(async () => 114),
      getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 1n, gasUsed: 100n })),
    };
    const walletClient = {
      account: buyerAccount,
      chain: null,
      signTypedData: vi.fn(async (args: any) => buyerAccount.signTypedData(args as never)),
      writeContract: vi.fn(async () => '0xapprovetx' as Hex),
    };
    return new FlareGaslessForwarderClient({
      publicClient: publicClient as never, walletClient: walletClient as never,
      forwarderAddress: FORWARDER, relayerUrl: 'http://relayer.test',
    });
  }

  it('reports needsApproval when allowance is zero', async () => {
    const c = makeClient();
    const status = await c.getStatus(buyerAccount.address);
    expect(status.needsApproval).toBe(true);
    expect(status.nonce).toBe(7n);
  });

  it('createAndSign produces a signature recoverable to the buyer (correct EIP-712 domain)', async () => {
    const c = makeClient();
    const req = await c.createAndSign({ to: PAY_TO, amount: 100_000n });
    expect(req.from).toBe(buyerAccount.address);
    expect(req.amount).toBe('100000');

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'GaslessPaymentForwarder', version: '1', chainId: 114, verifyingContract: FORWARDER },
      types: PAYMENT_REQUEST_TYPES,
      primaryType: 'PaymentRequest',
      message: {
        from: req.from,
        to: req.to,
        amount: BigInt(req.amount),
        nonce: 7n,
        deadline: BigInt(req.deadline),
      },
      signature: req.signature,
    });
    expect(recovered.toLowerCase()).toBe(buyerAccount.address.toLowerCase());
  });

  it('submitToRelayer surfaces relayer error as FLARE_GASLESS_RELAYER_REJECTED', async () => {
    const c = makeClient();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'expired' }), { status: 400 })) as never;
    const fakeReq: FlarePaymentRequest = {
      from: buyerAccount.address, to: PAY_TO, amount: '100000',
      deadline: 0, signature: ('0x' + 'd'.repeat(130)) as Hex,
    };
    await expect(c.submitToRelayer(fakeReq)).rejects.toMatchObject({ code: 'FLARE_GASLESS_RELAYER_REJECTED' });
  });
});

describe('createGaslessExecutor (relayer side)', () => {
  it('rejects a request whose signature does not recover to from', async () => {
    const publicClient = {
      readContract: vi.fn(async () => 0n),
      getChainId: vi.fn(async () => 114),
      getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
      waitForTransactionReceipt: vi.fn(),
    };
    const sponsorAccount = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex);
    const sponsorClient = { account: sponsorAccount, chain: null, writeContract: vi.fn() };
    const exec = createGaslessExecutor({
      publicClient: publicClient as never, sponsorClient: sponsorClient as never,
      forwarderAddress: FORWARDER,
    });

    // Build a *valid-format* signature (recoverable) that will not match `from`:
    // sign a wrong-domain message so recovery yields a different address.
    const sigForWrongDomain = await sponsorAccount.signTypedData({
      domain: { name: 'GaslessPaymentForwarder', version: '2', chainId: 114, verifyingContract: FORWARDER },
      types: PAYMENT_REQUEST_TYPES,
      primaryType: 'PaymentRequest',
      message: {
        from: buyerAccount.address, to: PAY_TO, amount: 100_000n, nonce: 0n, deadline: 99_999_999_999n,
      },
    } as never);
    const tampered: FlarePaymentRequest = {
      from: buyerAccount.address, to: PAY_TO, amount: '100000',
      deadline: 99_999_999_999, signature: sigForWrongDomain,
    };
    await expect(exec(tampered)).rejects.toMatchObject({ code: 'FLARE_GASLESS_BAD_SIGNATURE' });
    expect(sponsorClient.writeContract).not.toHaveBeenCalled();
  });
});
