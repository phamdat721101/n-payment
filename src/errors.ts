export class NPaymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'NPaymentError';
  }
}

export class ChallengeParseError extends NPaymentError {
  override name = 'ChallengeParseError';
}

export class InsufficientBalanceError extends NPaymentError {
  override name = 'InsufficientBalanceError';
}

export class AdapterNotFoundError extends NPaymentError {
  override name = 'AdapterNotFoundError';
}
