declare module 'xrpl' {
  export class Client {
    constructor(url: string);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    request(req: any): Promise<any>;
    autofill(tx: any): Promise<any>;
    submitAndWait(txBlob: string): Promise<any>;
  }
  export class Wallet {
    address: string;
    classicAddress: string;
    seed: string;
    static fromSeed(seed: string): Wallet;
    sign(transaction: any): { tx_blob: string; hash: string };
  }
}
