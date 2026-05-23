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
