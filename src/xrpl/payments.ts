import type { XrplWallet } from './wallet.js';
import type { XrplConnection } from './connection.js';

const RLUSD_CURRENCY = 'RLUSD';
const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';

export interface RlusdAmount {
  currency: string;
  issuer: string;
  value: string;
}

function rlusdAmount(value: string): RlusdAmount {
  return { currency: RLUSD_CURRENCY, issuer: RLUSD_ISSUER, value };
}

export async function ensureTrustLine(
  connection: XrplConnection,
  wallet: XrplWallet,
  issuer = RLUSD_ISSUER,
  currency = RLUSD_CURRENCY,
  limit = '1000000000',
): Promise<string | null> {
  const client = await connection.getClient();
  const address = await wallet.getAddress();

  // Check if trust line already exists
  const lines = await client.request({ command: 'account_lines', account: address });
  const exists = lines.result.lines?.some(
    (l: any) => l.currency === currency && l.account === issuer,
  );
  if (exists) return null;

  // Create trust line
  const tx = await client.autofill({
    TransactionType: 'TrustSet',
    Account: address,
    LimitAmount: { currency, issuer, value: limit },
  });
  const signed = await wallet.sign(tx);
  const result = await client.submitAndWait(signed.tx_blob);
  return result.result.hash;
}

export async function sendRLUSD(
  connection: XrplConnection,
  wallet: XrplWallet,
  destination: string,
  amount: string,
): Promise<{ hash: string; validated: boolean }> {
  const client = await connection.getClient();
  const address = await wallet.getAddress();

  const tx = await client.autofill({
    TransactionType: 'Payment',
    Account: address,
    Destination: destination,
    Amount: rlusdAmount(amount),
  });
  const signed = await wallet.sign(tx);
  const result = await client.submitAndWait(signed.tx_blob);
  return { hash: result.result.hash, validated: result.result.validated ?? false };
}

export async function getRLUSDBalance(
  connection: XrplConnection,
  address: string,
): Promise<string> {
  const client = await connection.getClient();
  const lines = await client.request({ command: 'account_lines', account: address });
  const rlusd = lines.result.lines?.find(
    (l: any) => l.currency === RLUSD_CURRENCY && l.account === RLUSD_ISSUER,
  );
  return rlusd?.balance ?? '0';
}
