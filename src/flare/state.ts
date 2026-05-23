import type { Address } from 'viem';
import { NPaymentError } from '../errors.js';
import {
  assetManagerAbi,
  erc20Abi,
  masterAccountControllerAbi,
  personalAccountAbi,
} from './abis.js';
import type { FlareClient } from './client.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface FlareVault {
  id: bigint;
  address: Address;
  /** 1 = Firelight, 2 = Upshift. */
  type: number;
}

export interface FlareAgentVault {
  id: bigint;
  address: Address;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ─── Personal account resolution ─────────────────────────────────────────────

/**
 * Resolve the PersonalAccount address for an XRPL classic address.
 * Returns the precomputed CREATE2 address even before the contract is deployed,
 * which is the canonical recipient for FXRP direct minting.
 */
export async function getPersonalAccountAddress(
  client: FlareClient,
  xrplAddress: string,
): Promise<Address> {
  const macAddress = await client.registry.address('MasterAccountController');
  const result = (await client.publicClient.readContract({
    address: macAddress,
    abi: masterAccountControllerAbi,
    functionName: 'getPersonalAccount',
    args: [xrplAddress],
  })) as Address;

  if (!result || result.toLowerCase() === ZERO_ADDRESS) {
    throw new NPaymentError(
      `Could not resolve PersonalAccount for XRPL address ${xrplAddress}`,
      'FLARE_PERSONAL_ACCOUNT_RESOLUTION_FAILED',
      'Verify the XRPL address is non-empty and rippled is reachable; the smart account is auto-deployed on first action.',
    );
  }
  return result;
}

/** True iff the EVM address is a deployed PersonalAccount (i.e. its `xrplOwner()` returns non-empty). */
export async function isSmartAccount(client: FlareClient, evmAddress: Address): Promise<boolean> {
  try {
    const owner = (await client.publicClient.readContract({
      address: evmAddress,
      abi: personalAccountAbi,
      functionName: 'xrplOwner',
      args: [],
    })) as string;
    return typeof owner === 'string' && owner.length > 0;
  } catch {
    return false;
  }
}

// ─── Operator XRPL addresses ────────────────────────────────────────────────

export async function getOperatorXrplAddresses(client: FlareClient): Promise<string[]> {
  const macAddress = await client.registry.address('MasterAccountController');
  return (await client.publicClient.readContract({
    address: macAddress,
    abi: masterAccountControllerAbi,
    functionName: 'getXrplProviderWallets',
    args: [],
  })) as string[];
}

// ─── FXRP token ──────────────────────────────────────────────────────────────

export async function getFxrpAddress(client: FlareClient): Promise<Address> {
  const assetManager = await client.registry.address('AssetManagerFXRP');
  return (await client.publicClient.readContract({
    address: assetManager,
    abi: assetManagerAbi,
    functionName: 'fAsset',
  })) as Address;
}

export async function getFxrpBalance(client: FlareClient, address: Address): Promise<bigint> {
  const fxrp = await getFxrpAddress(client);
  return (await client.publicClient.readContract({
    address: fxrp,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  })) as bigint;
}

export async function getFxrpDecimals(client: FlareClient): Promise<number> {
  const fxrp = await getFxrpAddress(client);
  const d = (await client.publicClient.readContract({
    address: fxrp,
    abi: erc20Abi,
    functionName: 'decimals',
  })) as number;
  return Number(d);
}

// ─── Vaults + agent vaults ───────────────────────────────────────────────────

export async function getVaults(client: FlareClient): Promise<FlareVault[]> {
  const macAddress = await client.registry.address('MasterAccountController');
  const result = (await client.publicClient.readContract({
    address: macAddress,
    abi: masterAccountControllerAbi,
    functionName: 'getVaults',
    args: [],
  })) as readonly [readonly bigint[], readonly Address[], readonly number[]];

  const [ids, addresses, types] = result;
  return ids.map((id, i) => ({ id, address: addresses[i]!, type: Number(types[i]) }));
}

export async function getAgentVaults(client: FlareClient): Promise<FlareAgentVault[]> {
  const macAddress = await client.registry.address('MasterAccountController');
  const result = (await client.publicClient.readContract({
    address: macAddress,
    abi: masterAccountControllerAbi,
    functionName: 'getAgentVaults',
    args: [],
  })) as readonly [readonly bigint[], readonly Address[]];

  const [ids, addresses] = result;
  return ids.map((id, i) => ({ id, address: addresses[i]! }));
}
