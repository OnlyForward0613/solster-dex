import { struct, u16, u8 } from 'buffer-layout';
import {
  bool,
  i64,
  Layout,
  option,
  publicKey,
  rustEnum,
  tagged,
  u64,
  vec,
  vecU8,
} from './borsh';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

export interface PoolState {
  poolTokenMint: PublicKey;
  assets: AssetInfo[];
  vaultSigner: PublicKey;
  vaultSignerNonce: number;
  accountParams: ParamDesc[];
  adminKey: PublicKey | null;
  customState: Buffer;
}

export interface AssetInfo {
  mint: PublicKey;
  vaultAddress: PublicKey;
}

export interface ParamDesc {
  address: PublicKey;
  writable: boolean;
}

export type PoolRequest =
  | { initialize: InitializePoolRequest }
  | { getBasket: PoolAction }
  | { transact: PoolAction };

export interface InitializePoolRequest {
  vaultSignerNonce: number;
  assetsLength: number;
  customStateLength: number;
}

export type PoolAction = { create: BN } | { redeem: BN } | { swap: Basket };

export interface Basket {
  quantities: BN[];
}

export const AssetInfo: Layout<AssetInfo> = struct([
  publicKey('mint'),
  publicKey('vaultAddress'),
]);

export const ParamDesc: Layout<ParamDesc> = struct([
  publicKey('address'),
  bool('writable'),
]);

export const POOL_STATE_TAG = new BN('16a7874c7fb2301b', 'hex');

export const PoolState: Layout<PoolState> = tagged(
  POOL_STATE_TAG,
  struct([
    publicKey('poolTokenMint'),
    vec(AssetInfo, 'assets'),
    publicKey('vaultSigner'),
    u8('vaultSignerNonce'),
    vec(ParamDesc, 'accountParams'),
    option(publicKey(), 'adminKey'),
    vecU8('customState'),
  ]),
);

export const Basket: Layout<Basket> = struct([vec(i64(), 'quantities')]);

export const PoolAction: Layout<PoolAction> = rustEnum([
  u64('create'),
  u64('redeem'),
  Basket.replicate('swap'),
]);

export const InitializePoolRequest: Layout<InitializePoolRequest> = struct([
  u8('vaultSignerNonce'),
  u8('assetsLength'),
  u16('customStateLength'),
]);

export const POOL_REQUEST_TAG = new BN('220a6cbdcd1cc4cf', 'hex');

export const PoolRequest: Layout<PoolRequest> = tagged(
  POOL_REQUEST_TAG,
  rustEnum([
    InitializePoolRequest.replicate('initialize'),
    PoolAction.replicate('getBasket'),
    PoolAction.replicate('transact'),
  ]),
);

export function isPoolState(data: Buffer): boolean {
  return data.slice(0, 8).equals(POOL_REQUEST_TAG.toBuffer('le'));
}

export function decodePoolState(data: Buffer): PoolState {
  return PoolState.decode(data);
}

export function encodePoolRequest(poolRequest: PoolRequest): Buffer {
  const buffer = Buffer.alloc(1000);
  const len = PoolRequest.encode(poolRequest, buffer);
  return buffer.slice(0, len);
}

export function decodePoolRequest(data: Buffer): PoolRequest {
  return PoolRequest.decode(data);
}
