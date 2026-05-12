declare module '@stellar/stellar-sdk' {
  export class Keypair {
    static fromSecret(secret: string): Keypair;
    publicKey(): string;
    sign(data: Buffer): Buffer;
  }
  export class TransactionBuilder {
    static fromXDR(xdr: string, networkPassphrase: string): any;
  }
}

declare module '@stellar/mpp' {
  export function createChargeCredential(params: {
    from: string;
    to: string;
    amount: string;
    asset: string;
    network: string;
  }): Promise<{ unsignedXdr: string }>;
}
