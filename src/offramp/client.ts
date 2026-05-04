import type { OffRampAdapter, OffRampQuoteParams, OffRampQuote, OffRampWithdrawParams, OffRampReceipt } from '../types.js';

export class OffRampClient {
  constructor(private adapter: OffRampAdapter) {}

  get provider(): string { return this.adapter.provider; }

  getSupportedCurrencies(): Promise<string[]> { return this.adapter.getSupportedCurrencies(); }
  getQuote(params: OffRampQuoteParams): Promise<OffRampQuote> { return this.adapter.getQuote(params); }
  withdraw(params: OffRampWithdrawParams): Promise<OffRampReceipt> { return this.adapter.withdraw(params); }
}
