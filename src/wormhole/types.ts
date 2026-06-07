/**
 * v0.22 — Wormhole NTT type contracts.
 *
 * The bridge primitive is abstracted as a factory so callers can:
 *   - inject a stub for tests (no Wormhole SDK install required)
 *   - inject a custom impl for advanced flows (e.g. multi-attest, custom relayer)
 *   - use the default impl that wraps `@wormhole-foundation/sdk-evm-ntt` (peer dep)
 *
 * SOLID — DIP: WormholeNttClient depends on WormholeNttBridgeFactory abstraction,
 * not the concrete Wormhole SDK.
 */

// ─── Wormhole chain identity ─────────────────────────────────────────────────

export type WormholeChainName = 'Ethereum' | 'Base' | 'Optimism' | 'Ink' | 'Unichain';

// ─── Deployment registry shape ───────────────────────────────────────────────

export interface NttDeployment {
  chainName: WormholeChainName;
  chainId: number;
  manager: `0x${string}`;
  token: `0x${string}`;
  transceiver: `0x${string}`;
  threshold: 1;
  mode: 'burning' | 'locking';
  inboundLimits: Partial<Record<WormholeChainName, bigint>>;
  outboundLimit: bigint;
  paused: boolean;
  owner: `0x${string}`;
}

export type CanBridgeResult =
  | { ok: true }
  | { ok: false; reason: string; suggestedFunding?: 'native' | 'swap' };

// ─── Signer abstraction ──────────────────────────────────────────────────────

/**
 * Minimal EVM signer surface. Compatible with `ethers.Wallet`, `viem.WalletClient`,
 * and the n-payment `OWSWormholeSigner` adapter. The default bridge factory uses
 * this to construct a Wormhole SDK signer at runtime.
 */
export interface EvmSigner {
  getAddress(): Promise<`0x${string}`>;
  /** Optional — forwarded to the Wormhole SDK. */
  signMessage?: (message: string) => Promise<string>;
  /** Optional — viem-style writeContract for direct submission. */
  writeContract?: (req: unknown) => Promise<`0x${string}`>;
}

// ─── Bridge primitive (the abstraction) ──────────────────────────────────────

export interface NttBridgeRequest {
  amount: bigint;
  recipient: `0x${string}`;
}

export interface NttBridgeResult {
  srcTxHash: `0x${string}`;
  /** Dest-chain redemption tx hash, present when redemption succeeded. */
  destTxHash?: `0x${string}`;
  /** Base64-encoded VAA (Wormhole signed message). */
  vaa?: string;
  durationMs: number;
}

/**
 * A bound bridge instance for a single (src → dst) lane. Construct via
 * {@link WormholeNttBridgeFactory.create}. Single-use — call sites build a
 * fresh bridge per transfer (cached per lane in WormholeNttClient).
 */
export interface WormholeNttBridge {
  transferAndRedeem(req: NttBridgeRequest): Promise<NttBridgeResult>;
}

export interface WormholeNttBridgeFactory {
  create(srcChain: WormholeChainName, dstChain: WormholeChainName): Promise<WormholeNttBridge>;
}

// ─── Client + adapter config ─────────────────────────────────────────────────

export interface NttTransferRequest {
  from: WormholeChainName;
  to: WormholeChainName;
  /** RLUSD base units (18 decimals). */
  amount: bigint;
  recipient: `0x${string}`;
  /** When true, do not submit — just preflight. Default false. */
  dryRun?: boolean;
}

export interface NttTransferReceipt {
  whTxId: string;
  vaa?: string;
  destTxHash?: `0x${string}`;
  status: 'submitted' | 'attested' | 'redeemed' | 'failed';
  durationMs: number;
}

export interface WormholeNttClientConfig {
  /** Wormhole network env. Default 'Mainnet'. */
  network?: 'Mainnet' | 'Testnet';
  /** Per-chain EVM signer. Missing entries soft-disable that source chain. */
  signers: Partial<Record<WormholeChainName, EvmSigner>>;
  /** Override bridge factory (tests, advanced wiring). Default: createDefaultWormholeNttBridgeFactory(). */
  bridgeFactory?: WormholeNttBridgeFactory;
  /** VAA polling timeout (ms). Default 600_000 (10 min). */
  attestationTimeoutMs?: number;
  /** VAA polling interval (ms). Default 5_000. */
  attestationPollMs?: number;
  /** Throw on missing signer instead of returning preflight ok=false. Default false. */
  strict?: boolean;
}

export interface WormholeNttAdapterOptions {
  /** Per-call cap (UBA). Throws if request exceeds. */
  maxPerTransfer?: bigint;
  /** Rolling 24h cap (UBA). */
  maxPerDay?: bigint;
}
