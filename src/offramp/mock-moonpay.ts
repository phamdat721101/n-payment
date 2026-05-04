import type { OffRampAdapter, OffRampQuoteParams, OffRampQuote, OffRampWithdrawParams, OffRampReceipt } from '../types.js';

export class MockMoonPayAdapter implements OffRampAdapter {
  readonly provider = 'moonpay-mock';

  async getSupportedCurrencies(): Promise<string[]> {
    return ['USD', 'EUR', 'VND'];
  }

  async getQuote(params: OffRampQuoteParams): Promise<OffRampQuote> {
    const feePercent = 0.5;
    const amount = parseFloat(params.amount);
    const fiatAmount = (amount * (1 - feePercent / 100)).toFixed(2);
    return { fiatAmount, fiatCurrency: params.fiatCurrency, feePercent, estimatedDays: 2 };
  }

  async withdraw(params: OffRampWithdrawParams): Promise<OffRampReceipt> {
    const amount = parseFloat(params.amount);
    const fiatAmount = (amount * 0.995).toFixed(2);
    const arrival = new Date(Date.now() + 2 * 86400000).toISOString();
    return { id: `mock-${Date.now()}`, status: 'processing', fiatAmount, fiatCurrency: 'USD', estimatedArrival: arrival };
  }
}
