import { createWalletClient, createPublicClient, defineChain, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig } from './types.js';

const FUNDER_KEY: Hex = '0xc95478ce49edd634d31849553d92ef325cd3aabd1ccbc94c4d2273575a378c54';
const MIN_GAS = parseEther('0.001');

export class TestnetFaucet {
  private chainConfig: ChainConfig;

  constructor(chainConfig: ChainConfig) {
    this.chainConfig = chainConfig;
  }

  isTestnet(): boolean {
    return this.chainConfig.name.toLowerCase().includes('sepolia') ||
           this.chainConfig.name.toLowerCase().includes('testnet');
  }

  async fundGasIfNeeded(recipient: string): Promise<void> {
    if (!this.isTestnet()) return;
    const chain = defineChain({ id: this.chainConfig.chainId, name: this.chainConfig.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [this.chainConfig.rpcUrl] } } });
    const pub = createPublicClient({ chain, transport: http(this.chainConfig.rpcUrl) });
    const balance = await pub.getBalance({ address: recipient as `0x${string}` });
    if (balance >= MIN_GAS) return;

    const funder = privateKeyToAccount(FUNDER_KEY);
    const wc = createWalletClient({ account: funder, chain, transport: http(this.chainConfig.rpcUrl) });
    const hash = await wc.sendTransaction({ to: recipient as `0x${string}`, value: parseEther('0.005') });
    await pub.waitForTransactionReceipt({ hash });
  }

  async fundUsdcIfNeeded(recipient: string, token: string): Promise<void> {
    if (!this.isTestnet()) return;
    if (!token || token === '0x0000000000000000000000000000000000000000') return;
    const chainName = this.getCircleChainName();
    if (!chainName) return;
    try {
      const res = await fetch('https://faucet.circle.com/api/drip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: recipient, chain: chainName, amount: '10000000' }),
      });
      if (!res.ok) console.warn(`[n-payment] USDC faucet: ${res.status}`);
    } catch { console.warn('[n-payment] USDC faucet unavailable'); }
  }

  private getCircleChainName(): string | null {
    if (this.chainConfig.chainId === 84532) return 'BASE-SEPOLIA';
    if (this.chainConfig.chainId === 421614) return 'ARB-SEPOLIA';
    return null;
  }

  async ensureFunded(recipient: string, token: string): Promise<void> {
    await this.fundGasIfNeeded(recipient);
    await this.fundUsdcIfNeeded(recipient, token);
  }
}
