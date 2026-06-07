import { NPaymentError } from '../errors.js';
import { canBridgeRlusd, RLUSD_NTT_DEPLOYMENTS } from './deployments.js';
import type {
  NttBridgeRequest,
  NttBridgeResult,
  NttTransferReceipt,
  NttTransferRequest,
  WormholeChainName,
  WormholeNttBridge,
  WormholeNttBridgeFactory,
  WormholeNttClientConfig,
} from './types.js';

/**
 * v0.22 — Wormhole NTT client.
 *
 * SOLID — SRP: orchestrates preflight + bridge invocation + caching only.
 * The actual cross-chain transfer is delegated to a {@link WormholeNttBridgeFactory}
 * (default impl wraps `@wormhole-foundation/sdk-evm-ntt`; tests inject a stub).
 *
 * Soft-disable: when no signer for `req.from`, preflight returns ok=false —
 * the corridor (PRD-C) routes around it instead of throwing.
 */
export class WormholeNttClient {
  private readonly factory: WormholeNttBridgeFactory;
  private readonly bridges = new Map<string, Promise<WormholeNttBridge>>();

  constructor(public readonly config: WormholeNttClientConfig) {
    this.factory = config.bridgeFactory ?? createDefaultWormholeNttBridgeFactory(config);
  }

  /** Pure-fn-style preflight: combines static deployment limits + signer availability. */
  preflight(req: NttTransferRequest): { ok: true } | { ok: false; reason: string } {
    if (!this.config.signers[req.from]) {
      return { ok: false, reason: `no-signer-for-${req.from}` };
    }
    const decision = canBridgeRlusd(req.from, req.to, req.amount);
    if (!decision.ok) return { ok: false, reason: decision.reason };
    return { ok: true };
  }

  async transfer(req: NttTransferRequest): Promise<NttTransferReceipt> {
    const t0 = Date.now();
    if (req.dryRun) {
      const pf = this.preflight(req);
      return {
        whTxId: 'dry-run',
        status: pf.ok ? 'submitted' : 'failed',
        durationMs: Date.now() - t0,
      };
    }

    const pf = this.preflight(req);
    if (!pf.ok) {
      throw new NPaymentError(
        `Wormhole NTT preflight failed: ${pf.reason}`,
        'WORMHOLE_NTT_PREFLIGHT_FAILED',
        'Check chain pause state, outbound/inbound rate limits, and signer config.',
      );
    }

    const bridge = await this.getBridge(req.from, req.to);
    const result = await bridge.transferAndRedeem({ amount: req.amount, recipient: req.recipient });

    return {
      whTxId: result.srcTxHash,
      vaa: result.vaa,
      destTxHash: result.destTxHash,
      status: result.destTxHash ? 'redeemed' : 'attested',
      durationMs: result.durationMs,
    };
  }

  private getBridge(from: WormholeChainName, to: WormholeChainName): Promise<WormholeNttBridge> {
    const key = `${from}->${to}`;
    let p = this.bridges.get(key);
    if (!p) {
      p = this.factory.create(from, to);
      this.bridges.set(key, p);
    }
    return p;
  }
}

// ─── Default bridge factory ──────────────────────────────────────────────────

/**
 * Default factory — lazy-loads `@wormhole-foundation/sdk` +
 * `@wormhole-foundation/sdk-evm` + `@wormhole-foundation/sdk-evm-ntt`
 * (declared as optional peer deps in package.json).
 *
 * If the peer deps are missing, calling create() throws
 * `WORMHOLE_NTT_PEER_DEP_MISSING` with the install command.
 *
 * The exact SDK invocation is captured per `examples/rlusd-ntt-bridge-only.ts`
 * — the canonical reference for production wiring. Advanced users override
 * via `WormholeNttClientConfig.bridgeFactory`.
 */
export function createDefaultWormholeNttBridgeFactory(
  config: WormholeNttClientConfig,
): WormholeNttBridgeFactory {
  return {
    async create(srcChain, dstChain): Promise<WormholeNttBridge> {
      const sdk = await loadWormholeSdk();
      const signer = config.signers[srcChain];
      if (!signer) {
        throw new NPaymentError(
          `No signer configured for ${srcChain}`,
          'WORMHOLE_NTT_NO_SIGNER',
          `Pass wormhole.signers.${srcChain} when constructing PaymentClient.`,
        );
      }

      const network = config.network ?? 'Mainnet';
      const wh = await sdk.wormhole(network, [sdk.evmPlatform]);
      const srcCtx = wh.getChain(srcChain);

      const srcDeployment = RLUSD_NTT_DEPLOYMENTS[srcChain];
      const ntt = await srcCtx.getProtocol('Ntt', {
        ntt: {
          token: srcDeployment.token,
          manager: srcDeployment.manager,
          transceiver: { wormhole: srcDeployment.transceiver },
        },
      });

      return {
        async transferAndRedeem(req: NttBridgeRequest): Promise<NttBridgeResult> {
          const t0 = Date.now();
          const senderAddr = await signer.getAddress();
          const xfer = ntt.transfer(
            senderAddr,
            req.amount,
            { chain: dstChain, address: req.recipient },
            { queue: false, automatic: true, gasDropoff: 0n },
          );
          const txids = await sdk.signSendWait(srcCtx, xfer, signer);
          const srcTxHash = txids[txids.length - 1].txid as `0x${string}`;

          // Auto-relayer often delivers inside the SDK. If it didn't, callers can
          // poll Wormholescan separately. Receipt surface is a structured stub —
          // the canonical `transferAndRedeem` is in examples/rlusd-ntt-bridge-only.ts
          // where Wormholescan polling + manual redeem are wired explicitly.
          return { srcTxHash, durationMs: Date.now() - t0 };
        },
      };
    },
  };
}

// ─── Lazy peer-dep loader ────────────────────────────────────────────────────

interface LoadedWormholeSdk {
  wormhole: (network: string, platforms: unknown[]) => Promise<WormholeContext>;
  signSendWait: (ctx: unknown, xfer: unknown, signer: unknown) => Promise<Array<{ txid: string }>>;
  evmPlatform: unknown;
}

interface WormholeContext {
  getChain(name: string): WormholeChainContext;
}
interface WormholeChainContext {
  getProtocol(name: 'Ntt', cfg: unknown): Promise<NttProtocol>;
}
interface NttProtocol {
  transfer(
    sender: `0x${string}`,
    amount: bigint,
    dst: { chain: string; address: `0x${string}` },
    opts: { queue: boolean; automatic: boolean; gasDropoff: bigint },
  ): unknown;
}

let cached: Promise<LoadedWormholeSdk> | undefined;
async function loadWormholeSdk(): Promise<LoadedWormholeSdk> {
  cached ??= (async () => {
    try {
      const core = await import('@wormhole-foundation/sdk' as string);
      const evm = await import('@wormhole-foundation/sdk-evm' as string);
      // Side-effect import: registers the Ntt protocol on the EVM platform.
      await import('@wormhole-foundation/sdk-evm-ntt' as string);
      return {
        wormhole: core.wormhole as LoadedWormholeSdk['wormhole'],
        signSendWait: core.signSendWait as LoadedWormholeSdk['signSendWait'],
        evmPlatform: evm.default ?? evm,
      };
    } catch (err) {
      throw new NPaymentError(
        `Wormhole SDK peer-dep missing: ${(err as Error).message}`,
        'WORMHOLE_NTT_PEER_DEP_MISSING',
        'Run: pnpm add @wormhole-foundation/sdk @wormhole-foundation/sdk-evm @wormhole-foundation/sdk-evm-ntt',
      );
    }
  })();
  return cached;
}
