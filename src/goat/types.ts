export type GoatOrderStatus =
  | 'CHECKOUT_VERIFIED'
  | 'PAYMENT_CONFIRMED'
  | 'INVOICED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export const TERMINAL_STATES: GoatOrderStatus[] = [
  'PAYMENT_CONFIRMED', 'INVOICED', 'FAILED', 'EXPIRED', 'CANCELLED',
];

export interface GoatOrder {
  orderId: string;
  payToAddress: string;
  amountWei: string;
  flow: string;
  calldataSignRequest?: unknown;
  status: GoatOrderStatus;
}

export interface GoatProof {
  payload: {
    order_id: string;
    tx_hash: string;
    log_index: number;
    from_addr: string;
    to_addr: string;
    amount_wei: string;
    chain_id: number;
    flow: string;
  };
  signature: string;
}

export interface GoatCreateOrderParams {
  dappOrderId: string;
  chainId: number;
  tokenSymbol: string;
  fromAddress: string;
  amountWei: string;
  tokenContract?: string;
  callbackCalldata?: string;
}
