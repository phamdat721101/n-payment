/**
 * Hand-trimmed ABI subset for the Flare contracts the FXRP bridge calls.
 * Keep the smallest possible footprint — every function listed here is one
 * the SDK actively reads or writes. Pulled from the published Flare docs:
 *   https://dev.flare.network/smart-accounts/reference
 *   https://dev.flare.network/fassets/reference
 */

export const flareContractRegistryAbi = [
  {
    type: 'function',
    name: 'getContractAddressByName',
    stateMutability: 'view',
    inputs: [{ name: '_name', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

export const assetManagerAbi = [
  {
    type: 'function',
    name: 'fAsset',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'directMintingPaymentAddress',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'getDirectMintingFeeBIPS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getDirectMintingMinimumFeeUBA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getDirectMintingExecutorFeeUBA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getDirectMintingLargeMintingThresholdUBA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ─── v0.22.1 — FAssets redemption (FXRP → XRP on XRPL) ─────────────────
  {
    type: 'function',
    name: 'redeem',
    stateMutability: 'payable',
    inputs: [
      { name: 'lots', type: 'uint256' },
      { name: 'redeemerUnderlyingAddressString', type: 'string' },
      { name: 'executor', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRedemptionFeeBIPS',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRedemptionMinimumFeeUBA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRedemptionExecutorFeeUBA',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'lotSize',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'RedemptionRequested',
    inputs: [
      { name: 'redeemer', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
      { name: 'paymentAmountUBA', type: 'uint256', indexed: false },
      { name: 'paymentAddress', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RedemptionPerformed',
    inputs: [
      { name: 'redeemer', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
      { name: 'transactionHash', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RedemptionPaymentFailed',
    inputs: [
      { name: 'redeemer', type: 'address', indexed: true },
      { name: 'requestId', type: 'uint256', indexed: true },
      { name: 'failureReason', type: 'string', indexed: false },
    ],
  },
] as const;

export const masterAccountControllerAbi = [
  {
    type: 'function',
    name: 'getPersonalAccount',
    stateMutability: 'view',
    inputs: [{ name: 'xrplAddress', type: 'string' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getXrplProviderWallets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string[]' }],
  },
  {
    type: 'function',
    name: 'getVaults',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'ids', type: 'uint256[]' },
      { name: 'addresses', type: 'address[]' },
      { name: 'types', type: 'uint8[]' },
    ],
  },
  {
    type: 'function',
    name: 'getAgentVaults',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'ids', type: 'uint256[]' },
      { name: 'addresses', type: 'address[]' },
    ],
  },
] as const;

export const personalAccountAbi = [
  {
    type: 'function',
    name: 'xrplOwner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;
