import { describe, it, expect, vi } from 'vitest';
import { FlareClient } from '../src/flare/client.js';
import { FlareBridgeClient } from '../src/flare/bridge.js';
import { DIRECT_MINTING_MEMO_PREFIX } from '../src/flare/direct-minting.js';

const ASSET_MANAGER = '0x1111111111111111111111111111111111111111';
const MASTER_AC = '0x2222222222222222222222222222222222222222';
const PERSONAL_ACCOUNT = '0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9F';
const CORE_VAULT_XRPL = 'rCoreVault123';
const XRPL_ADDR = 'rPdLcCkSJzLvURM2vV3bCWwXBgT7FyJojU';

function makeFlareClient(): FlareClient {
  const reads: Record<string, unknown> = {
    [`${MASTER_AC.toLowerCase()}::getPersonalAccount`]: PERSONAL_ACCOUNT,
    [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingFeeBIPS`]: 200n,
    [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingMinimumFeeUBA`]: 0n,
    [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingExecutorFeeUBA`]: 200_000n,
    [`${ASSET_MANAGER.toLowerCase()}::directMintingPaymentAddress`]: CORE_VAULT_XRPL,
    [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingLargeMintingThresholdUBA`]: 1_000_000_000n,
  };
  const readContract = vi.fn(async (req: { address: string; functionName: string }) => {
    const key = `${req.address.toLowerCase()}::${req.functionName}`;
    if (!(key in reads)) throw new Error(`unmocked: ${key}`);
    return reads[key];
  });
  const client = new FlareClient({ publicClient: { readContract } as never });
  const cache = (client.registry as unknown as { cache: Map<string, { address: string; expiresAt: number }> }).cache;
  cache.set('AssetManagerFXRP', { address: ASSET_MANAGER, expiresAt: Date.now() + 1e9 });
  cache.set('MasterAccountController', { address: MASTER_AC, expiresAt: Date.now() + 1e9 });
  return client;
}

function makeXrplStubs(opts: { engine?: string; hash?: string } = {}) {
  const submitAndWait = vi.fn(async () => ({
    result: {
      hash: opts.hash ?? 'XRPL_TX_HASH',
      validated: true,
      meta: { TransactionResult: opts.engine ?? 'tesSUCCESS' },
    },
  }));
  const xrplClient = {
    autofill: vi.fn(async (tx: Record<string, unknown>) => tx),
    submitAndWait,
  };
  const xrplConnection = { getClient: vi.fn(async () => xrplClient) } as never;
  const xrplWallet = {
    getAddress: vi.fn(async () => XRPL_ADDR),
    sign: vi.fn(async (_tx: Record<string, unknown>) => ({
      tx_blob: 'BLOB',
      hash: 'PRESIGNED_HASH',
    })),
  } as never;
  return { xrplConnection, xrplWallet, xrplClient };
}

describe('FlareBridgeClient.mintFXRP', () => {
  it('happy path: preflights in parallel, encodes memo, submits one XRPL Payment', async () => {
    const flare = makeFlareClient();
    const { xrplConnection, xrplWallet, xrplClient } = makeXrplStubs();
    const bridge = new FlareBridgeClient({ flare, xrplConnection, xrplWallet });

    const receipt = await bridge.mintFXRP({ amountXrp: '10' });

    expect(receipt.xrplTxHash).toBe('XRPL_TX_HASH');
    expect(receipt.xrplValidated).toBe(true);
    expect(receipt.netFxrp).toBe('10');
    expect(receipt.paymentXrp).toBe('10.4'); // 10 + 0.2 proportional + 0.2 executor = 10.4
    expect(receipt.recipientPersonalAccount).toBe(PERSONAL_ACCOUNT);
    expect(receipt.coreVaultXrplAddress).toBe(CORE_VAULT_XRPL);
    expect(receipt.rateLimit).toEqual({ large: false, largeThresholdUBA: 1_000_000_000n });

    // Memo bytes are correctly attached to the Payment.
    const submittedTx = (xrplClient.submitAndWait as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    void submittedTx; // tx_blob is opaque; assert against the autofilled tx instead
    const autofilled = (xrplClient.autofill as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      Memos: { Memo: { MemoData: string } }[];
      Destination: string;
      Amount: string;
    };
    expect(autofilled.Destination).toBe(CORE_VAULT_XRPL);
    expect(autofilled.Amount).toBe('10400000');
    expect(autofilled.Memos[0]!.Memo.MemoData).toMatch(
      new RegExp(`^${DIRECT_MINTING_MEMO_PREFIX.toUpperCase()}00000000`),
    );
    expect(autofilled.Memos[0]!.Memo.MemoData.toLowerCase()).toContain(
      PERSONAL_ACCOUNT.slice(2).toLowerCase(),
    );
  });

  it('rejects amountXrp = 0 with FLARE_INVALID_AMOUNT', async () => {
    const flare = makeFlareClient();
    const { xrplConnection, xrplWallet } = makeXrplStubs();
    const bridge = new FlareBridgeClient({ flare, xrplConnection, xrplWallet });
    await expect(bridge.mintFXRP({ amountXrp: '0' })).rejects.toMatchObject({
      code: 'FLARE_INVALID_AMOUNT',
    });
  });

  it('maps non-tesSUCCESS engine results to FLARE_BRIDGE_SUBMIT_FAILED', async () => {
    const flare = makeFlareClient();
    const stubs = makeXrplStubs({ engine: 'tecPATH_PARTIAL', hash: 'BAD_HASH' });
    const bridge = new FlareBridgeClient({
      flare,
      xrplConnection: stubs.xrplConnection,
      xrplWallet: stubs.xrplWallet,
    });
    await expect(bridge.mintFXRP({ amountXrp: '10' })).rejects.toMatchObject({
      code: 'FLARE_BRIDGE_SUBMIT_FAILED',
    });
  });

  it('per-wallet mutex serialises concurrent calls (one Payment at a time)', async () => {
    const flare = makeFlareClient();
    const { xrplConnection, xrplWallet, xrplClient } = makeXrplStubs();

    // Make submitAndWait take a microtask so both calls overlap if not serialised.
    let inFlight = 0;
    let maxInFlight = 0;
    (xrplClient.submitAndWait as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        result: { hash: 'X', validated: true, meta: { TransactionResult: 'tesSUCCESS' } },
      };
    });

    const bridge = new FlareBridgeClient({ flare, xrplConnection, xrplWallet });
    await Promise.all([
      bridge.mintFXRP({ amountXrp: '5' }),
      bridge.mintFXRP({ amountXrp: '7' }),
    ]);
    expect(maxInFlight).toBe(1);
  });
});
