import { seq, struct } from 'buffer-layout';
import { publicKeyLayout, u128, u64, WideBits } from './layout';
import { SLAB_LAYOUT } from './slab-layout';

export function accountFlags(property = 'accountFlags') {
  const layout = new WideBits(property);
  layout.addBoolean('initialized');
  layout.addBoolean('market');
  layout.addBoolean('openOrders');
  layout.addBoolean('requestQueue');
  layout.addBoolean('eventQueue');
  layout.addBoolean('bids');
  layout.addBoolean('asks');
  return layout;
}

export const MARKET_STATE_LAYOUT = struct([
  accountFlags('accountFlags'),

  publicKeyLayout('ownAddress'),

  u64('vaultSignerNonce'),

  publicKeyLayout('baseMint'),
  publicKeyLayout('quoteMint'),

  publicKeyLayout('baseVault'),
  u64('baseDepositsTotal'),
  u64('baseFeesAccrued'),

  publicKeyLayout('quoteVault'),
  u64('quoteDepositsTotal'),
  u64('quoteFeesAccrued'),

  u64('quoteDustThreshold'),

  publicKeyLayout('requestQueue'),
  publicKeyLayout('eventQueue'),

  publicKeyLayout('bids'),
  publicKeyLayout('asks'),

  u64('baseLotSize'),
  u64('quoteLotSize'),
]);

export const OPEN_ORDERS_LAYOUT = struct([
  accountFlags('accountFlags'),

  publicKeyLayout('market'),
  publicKeyLayout('owner'),

  // These are in native (i.e. not lot) units
  u64('baseTotal'),
  u64('baseFree'),
  u64('quoteTotal'),
  u64('quoteFree'),

  u128('freeSlotBits'),
  u128('isBidBits'),

  seq(u128(), 128, 'orders'),
]);

export const ORDERBOOK_LAYOUT = struct([
  accountFlags('accountFlags'),
  SLAB_LAYOUT.replicate('slab'),
]);
