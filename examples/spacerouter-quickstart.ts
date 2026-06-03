/**
 * SpaceRouter quickstart — the canonical "two prompts, zero crypto setup" demo for
 * Creditcoin + SpaceRouter. Defaults to cc3-testnet (chainId 102031); switch to
 * Creditcoin mainnet with `SR_NETWORK=mainnet`.
 *
 * Two subcommands map 1:1 to the canonical agent prompts:
 *   - `check` → "check my balance on creditcoin-mainnet"
 *   - `pay`   → "pay for httpbin.org/ip via SpaceRouter, region KR, residential"
 *
 * Usage:
 *   export CREDITCOIN_PRIVATE_KEY=0x...
 *   npx tsx examples/spacerouter-quickstart.ts check
 *   npx tsx examples/spacerouter-quickstart.ts pay --url https://httpbin.org/ip --region KR --ip-type residential
 *
 * Optional env:
 *   SR_NETWORK              = testnet (default) | mainnet
 *   SR_ESCROW_ADDRESS       = TokenPaymentEscrow address (testnet override; mainnet uses 0xC130F5...)
 *   SR_TOKEN_ADDRESS        = SPACE/SPC token override (testnet override; mainnet uses 0x7ab7C6...)
 *   SR_GATEWAY_URL          = override the chain's facilitator URL
 *   SR_API_KEY              = optional gateway API key
 *
 * Peer dep (only required for `pay`, not `check`):
 *   pnpm add @spacenetwork/spacerouter
 */
import {
  CHAINS,
  SpaceRouterClient,
  SpaceRouterEscrowClient,
  KeypairSpaceRouterSigner,
  parseSpace, formatSpace,
  NPaymentError,
  type ChainKey,
} from '../src/index.js';
import type { Address, Hex } from 'viem';

// ─── Tiny arg parser (no extra deps) ─────────────────────────────────────────

type ParsedArgs = { _: string[]; flags: Record<string, string> };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = 'true';
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(tok);
    }
  }
  return { _: positional, flags };
}

// ─── Config resolution ──────────────────────────────────────────────────────

function resolveChainKey(): ChainKey {
  return process.env.SR_NETWORK === 'mainnet' ? 'creditcoin-mainnet' : 'creditcoin-testnet';
}

const MAINNET_ESCROW = '0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0' as const;

function resolveEscrowAddress(chainKey: ChainKey): Address {
  if (process.env.SR_ESCROW_ADDRESS) return process.env.SR_ESCROW_ADDRESS as Address;
  if (chainKey === 'creditcoin-mainnet') return MAINNET_ESCROW;
  throw new Error(
    'SR_ESCROW_ADDRESS env var is required for cc3-testnet (the testnet escrow is operator-deployed; no canonical default).',
  );
}

function resolveTokenAddress(chainKey: ChainKey): Address {
  if (process.env.SR_TOKEN_ADDRESS) return process.env.SR_TOKEN_ADDRESS as Address;
  const chain = CHAINS[chainKey];
  // Mainnet: SPACE; testnet: SPC. Both are stored under the chain config tokens map.
  const addr = (chain.tokens.SPACE ?? chain.tokens.SPC) as Address | undefined;
  if (!addr || addr === '0x0000000000000000000000000000000000000000') {
    throw new Error(
      'SR_TOKEN_ADDRESS env var is required for cc3-testnet (no canonical token address in chains.ts).',
    );
  }
  return addr;
}

function loadPrivateKey(): Hex {
  const pk = process.env.CREDITCOIN_PRIVATE_KEY;
  if (!pk) throw new Error('CREDITCOIN_PRIVATE_KEY env var is required.');
  return pk.startsWith('0x') ? (pk as Hex) : (`0x${pk}` as Hex);
}

// ─── Subcommands ────────────────────────────────────────────────────────────

async function runCheck(): Promise<void> {
  const chainKey = resolveChainKey();
  const chain = CHAINS[chainKey];
  const signer = new KeypairSpaceRouterSigner(loadPrivateKey());
  const consumer = await signer.getAddress();

  const escrow = new SpaceRouterEscrowClient({
    chain,
    escrowAddress: resolveEscrowAddress(chainKey),
    tokenAddress: resolveTokenAddress(chainKey),
    privateKey: loadPrivateKey(),
  });

  const balance = await escrow.getBalance(consumer);
  let maxRatePerGB: bigint | null = null;
  try {
    maxRatePerGB = await escrow.getMaxRatePerGB();
  } catch {
    // Older deployments may not expose maxRatePerGB() — non-fatal.
  }

  console.log(JSON.stringify({
    ok: true,
    data: {
      chain: chainKey,
      consumer,
      balanceWei: balance.toString(),
      balanceSpace: formatSpace(balance),
      maxRatePerGBWei: maxRatePerGB?.toString() ?? null,
      maxRatePerGBSpace: maxRatePerGB === null ? null : formatSpace(maxRatePerGB),
    },
  }, null, 2));
}

async function runPay(args: ParsedArgs): Promise<void> {
  const url = args.flags.url;
  if (!url) throw new Error('--url is required');
  const region = (args.flags.region as 'US' | 'KR' | 'JP' | 'GB' | undefined) ?? undefined;
  const ipType = (args.flags['ip-type'] as 'residential' | 'mobile' | 'business' | 'hosting' | undefined) ?? undefined;

  const chainKey = resolveChainKey();
  const chain = CHAINS[chainKey];
  const privateKey = loadPrivateKey();
  const signer = new KeypairSpaceRouterSigner(privateKey);

  const client = new SpaceRouterClient({
    chain,
    signer,
    escrowAddress: resolveEscrowAddress(chainKey),
    tokenAddress: resolveTokenAddress(chainKey),
    privateKey,
    gatewayUrl: process.env.SR_GATEWAY_URL ?? chain.facilitator,
    apiKey: process.env.SR_API_KEY,
    region,
    ipType,
  });

  try {
    const response = await client.fetch(url, undefined, { region, ipType });
    const text = await response.text();
    console.log(JSON.stringify({
      ok: true,
      data: {
        url,
        status: response.status,
        nodeId: response.headers.get('x-spacerouter-node-id'),
        requestId: response.headers.get('x-spacerouter-request-id'),
        bodyPreview: text.slice(0, 200),
      },
    }, null, 2));
  } finally {
    await client.close();
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'check';

  if (cmd === 'check') return runCheck();
  if (cmd === 'pay') return runPay(args);
  if (cmd === '--help' || cmd === 'help') {
    console.log([
      'Usage: tsx examples/spacerouter-quickstart.ts <check|pay> [flags]',
      '',
      '  check                          Read $SPACE escrow balance for the wallet.',
      '  pay --url <u> [--region KR]    Route an HTTP request through SpaceRouter.',
      '       [--ip-type residential]',
      '',
      'Env: CREDITCOIN_PRIVATE_KEY (required), SR_NETWORK=testnet|mainnet,',
      '     SR_ESCROW_ADDRESS, SR_TOKEN_ADDRESS, SR_GATEWAY_URL, SR_API_KEY.',
    ].join('\n'));
    return;
  }
  throw new Error(`Unknown command: ${cmd}. Try: check | pay | --help`);
}

// Only run when executed as a script (not when imported by tests).
const isMain = (() => {
  try { return import.meta.url === `file://${process.argv[1]}`; } catch { return false; }
})();

if (isMain) {
  main().catch((err) => {
    if (err instanceof NPaymentError) {
      console.error(JSON.stringify({ ok: false, error: err.message, code: err.code, hint: err.hint }, null, 2));
    } else {
      console.error(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
    }
    process.exit(1);
  });
}
