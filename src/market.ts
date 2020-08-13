import { blob, seq, struct, u8 } from 'buffer-layout';
import { accountFlagsLayout, publicKeyLayout, u128, u64 } from './layout';
import { Slab, SLAB_LAYOUT } from './slab';
import { DEX_PROGRAM_ID, DexInstructions } from './instructions';
import BN from 'bn.js';
import {
  Account,
  AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { decodeEventQueue, decodeRequestQueue } from './queue';
import { Buffer } from 'buffer';

export const MARKET_STATE_LAYOUT = struct([
  accountFlagsLayout('accountFlags'),

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

  u64('feeRateBps'),
]);

export class Market {
  private _decoded: any;
  private _baseSplTokenDecimals: number;
  private _quoteSplTokenDecimals: number;

  constructor(decoded, baseMintDecimals: number, quoteMintDecimals: number) {
    if (!decoded.accountFlags.initialized || !decoded.accountFlags.market) {
      throw new Error('Invalid market state');
    }
    this._decoded = decoded;
    this._baseSplTokenDecimals = baseMintDecimals;
    this._quoteSplTokenDecimals = quoteMintDecimals;
  }

  static get LAYOUT() {
    return MARKET_STATE_LAYOUT;
  }

  static async load(connection: Connection, address: PublicKey) {
    const { owner, data } = throwIfNull(
      await connection.getAccountInfo(address),
      'Market not found',
    );
    if (!owner.equals(DEX_PROGRAM_ID)) {
      throw new Error('Address not owned by program');
    }
    const decoded = MARKET_STATE_LAYOUT.decode(data);
    if (
      !decoded.accountFlags.initialized ||
      !decoded.accountFlags.market ||
      !decoded.ownAddress.equals(address)
    ) {
      throw new Error('Invalid market');
    }
    const [baseMintDecimals, quoteMintDecimals] = await Promise.all([
      getMintDecimals(connection, decoded.baseMint),
      getMintDecimals(connection, decoded.quoteMint),
    ]);
    return new Market(decoded, baseMintDecimals, quoteMintDecimals);
  }

  get address(): PublicKey {
    return this._decoded.ownAddress;
  }

  get publicKey(): PublicKey {
    return this.address;
  }

  get baseMintAddress(): PublicKey {
    return this._decoded.baseMint;
  }

  get quoteMintAddress(): PublicKey {
    return this._decoded.quoteMint;
  }

  async loadBids(connection: Connection): Promise<Orderbook> {
    const { data } = throwIfNull(
      await connection.getAccountInfo(this._decoded.bids),
    );
    return Orderbook.decode(this, data);
  }

  async loadAsks(connection: Connection): Promise<Orderbook> {
    const { data } = throwIfNull(
      await connection.getAccountInfo(this._decoded.asks),
    );
    return Orderbook.decode(this, data);
  }

  async findBaseTokenAccountsForOwner(
    connection: Connection,
    ownerAddress: PublicKey,
  ): Promise<Array<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>> {
    return (
      await connection.getTokenAccountsByOwner(ownerAddress, {
        mint: this.baseMintAddress,
      })
    ).value;
  }

  async findQuoteTokenAccountsForOwner(
    connection: Connection,
    ownerAddress: PublicKey,
  ): Promise<{ pubkey: PublicKey; account: AccountInfo<Buffer> }[]> {
    return (
      await connection.getTokenAccountsByOwner(ownerAddress, {
        mint: this.quoteMintAddress,
      })
    ).value;
  }

  async findOpenOrdersAccountsForOwner(
    connection: Connection,
    ownerAddress: PublicKey,
  ): Promise<OpenOrders[]> {
    return OpenOrders.findForMarketAndOwner(
      connection,
      this.address,
      ownerAddress,
    );
  }

  async placeOrder(
    connection: Connection,
    { owner, payer, side, price, size, orderType = 'limit' }: OrderParams,
  ) {
    const { transaction, signers } = await this.makePlaceOrderTransaction(
      connection,
      {
        owner,
        payer,
        side,
        price,
        size,
        orderType,
      },
    );
    return await connection.sendTransaction(transaction, signers);
  }

  async makePlaceOrderTransaction<T extends PublicKey | Account>(
    connection: Connection,
    { owner, payer, side, price, size, orderType = 'limit' }: OrderParams<T>,
  ) {
    // @ts-ignore
    const ownerAddress: PublicKey = owner.publicKey ?? owner;
    const openOrdersAccounts = await this.findOpenOrdersAccountsForOwner(
      connection,
      ownerAddress,
    ); // TODO: cache this
    const transaction = new Transaction();
    const signers: (T | Account)[] = [owner];
    let openOrdersAddress;
    if (openOrdersAccounts.length === 0) {
      const newOpenOrdersAccount = new Account();
      transaction.add(
        await OpenOrders.makeCreateAccountTransaction(
          connection,
          this.address,
          ownerAddress,
          newOpenOrdersAccount.publicKey,
        ),
      );
      openOrdersAddress = newOpenOrdersAccount.publicKey;
      signers.push(newOpenOrdersAccount);
    } else {
      openOrdersAddress = openOrdersAccounts[0].address;
    }
    transaction.add(
      DexInstructions.newOrder({
        market: this.address,
        requestQueue: this._decoded.requestQueue,
        baseVault: this._decoded.baseVault,
        quoteVault: this._decoded.quoteVault,
        openOrders: openOrdersAddress,
        owner: ownerAddress,
        payer,
        side,
        limitPrice: this.priceNumberToLots(price),
        maxQuantity: this.baseSizeNumberToLots(size),
        orderType,
      }),
    );
    return { transaction, signers };
  }

  async cancelOrder(connection: Connection, owner: Account, order) {
    const transaction = await this.makeCancelOrderTransaction(
      connection,
      order,
    );
    return await connection.sendTransaction(transaction, [owner]);
  }

  async makeCancelOrderTransaction(connection: Connection, order) {
    const openOrdersAccount = await this.findOpenOrdersAccountForOrder(
      connection,
      order,
    );
    if (openOrdersAccount === null) {
      throw new Error('Order not found');
    }
    const transaction = new Transaction();
    transaction.add(
      DexInstructions.cancelOrder({
        market: this.address,
        openOrders: openOrdersAccount.address,
        owner: order.owner,
        requestQueue: this._decoded.requestQueue,
        side: order.side,
        orderId: order.orderId,
        ownerSlot: order.ownerSlot,
      }),
    );
    return transaction;
  }

  async findOpenOrdersAccountForOrder(connection: Connection, order) {
    const openOrdersAccounts = await this.findOpenOrdersAccountsForOwner(
      connection,
      order.owner,
    );
    for (const account of openOrdersAccounts) {
      if (account.orders.some((orderId) => orderId.eq(order.orderId))) {
        return account;
      }
    }
    return null;
  }

  async loadRequestQueue(connection: Connection) {
    const { data } = throwIfNull(
      await connection.getAccountInfo(this._decoded.requestQueue),
    );
    return decodeRequestQueue(data);
  }

  async loadEventQueue(connection: Connection) {
    const { data } = throwIfNull(
      await connection.getAccountInfo(this._decoded.eventQueue),
    );
    return decodeEventQueue(data);
  }

  async loadFills(connection: Connection, limit = 100) {
    // TODO: once there's a separate source of fills use that instead
    const { data } = throwIfNull(
      await connection.getAccountInfo(this._decoded.eventQueue),
    );
    const events = decodeEventQueue(data, limit);
    return events
      .filter((event) => event.eventFlags.fill && event.quantityPaid.gtn(0))
      .map((event) =>
        event.eventFlags.bid
          ? {
              ...event,
              size: this.baseSizeLotsToNumber(event.quantityReleased),
              price: this.priceLotsToNumber(
                event.quantityPaid.divRound(event.quantityReleased),
              ),
              side: 'buy',
            }
          : {
              ...event,
              size: this.baseSizeLotsToNumber(event.quantityPaid),
              price: this.priceLotsToNumber(
                event.quantityReleased.divRound(event.quantityPaid),
              ),
              side: 'sell',
            },
      );
  }

  private get _baseSplTokenMultiplier() {
    return new BN(10).pow(new BN(this._baseSplTokenDecimals));
  }

  private get _quoteSplTokenMultiplier() {
    return new BN(10).pow(new BN(this._quoteSplTokenDecimals));
  }

  priceLotsToNumber(price: BN) {
    return divideBnToNumber(
      price.mul(this._decoded.quoteLotSize).mul(this._baseSplTokenMultiplier),
      this._decoded.baseLotSize.mul(this._quoteSplTokenMultiplier),
    );
  }

  priceNumberToLots(price: number): BN {
    return new BN(
      Math.round(
        (price *
          Math.pow(10, this._quoteSplTokenDecimals) *
          this._decoded.baseLotSize.toNumber()) /
          (Math.pow(10, this._baseSplTokenDecimals) *
            this._decoded.quoteLotSize.toNumber()),
      ),
    );
  }

  baseSizeLotsToNumber(size: BN) {
    return divideBnToNumber(
      size.mul(this._decoded.baseLotSize),
      this._baseSplTokenMultiplier,
    );
  }

  baseSizeNumberToLots(size: number): BN {
    const native = new BN(
      Math.round(size * Math.pow(10, this._baseSplTokenDecimals)),
    );
    // rounds down to the nearest lot size
    return native.div(this._decoded.baseLotSize);
  }

  quoteSizeLotsToNumber(size: BN) {
    return divideBnToNumber(
      size.mul(this._decoded.quoteLotSize),
      this._quoteSplTokenMultiplier,
    );
  }

  quoteSizeNumberToLots(size: number): BN {
    const native = new BN(
      Math.round(size * Math.pow(10, this._quoteSplTokenDecimals)),
    );
    // rounds down to the nearest lot size
    return native.div(this._decoded.quoteLotSize);
  }

  async matchOrders(connection: Connection, feePayer: Account, limit: number) {
    const tx = new Transaction();
    tx.add(
      DexInstructions.matchOrders({
        market: this.address,
        requestQueue: this._decoded.requestQueue,
        eventQueue: this._decoded.eventQueue,
        bids: this._decoded.bids,
        asks: this._decoded.asks,
        baseVault: this._decoded.baseVault,
        quoteVault: this._decoded.quoteVault,
        limit,
      }),
    );
    return await connection.sendTransaction(tx, [feePayer]);
  }
}

export interface OrderParams<T = Account> {
  owner: T;
  payer: PublicKey;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  orderType?: 'limit' | 'ioc' | 'postOnly';
}

export const OPEN_ORDERS_LAYOUT = struct([
  accountFlagsLayout('accountFlags'),

  publicKeyLayout('market'),
  publicKeyLayout('owner'),

  // These are in spl-token (i.e. not lot) units
  u64('baseTokenFree'),
  u64('baseTokenTotal'),
  u64('quoteTokenFree'),
  u64('quoteTokenTotal'),

  u128('freeSlotBits'),
  u128('isBidBits'),

  seq(u128(), 128, 'orders'),
]);

export class OpenOrders {
  address: PublicKey;
  market!: PublicKey;
  owner!: PublicKey;

  baseTokenFree!: BN;
  baseTokenTotal!: BN;
  quoteTokenFree!: BN;
  quoteTokenTotal!: BN;

  orders!: BN[];

  constructor(address: PublicKey, decoded) {
    this.address = address;
    Object.assign(this, decoded);
  }

  static get LAYOUT() {
    return OPEN_ORDERS_LAYOUT;
  }

  static async findForMarketAndOwner(
    connection: Connection,
    marketAddress: PublicKey,
    ownerAddress: PublicKey,
  ) {
    const filters = [
      {
        memcmp: {
          offset: OPEN_ORDERS_LAYOUT.offsetOf('market'),
          bytes: marketAddress.toBase58(),
        },
      },
      {
        memcmp: {
          offset: OPEN_ORDERS_LAYOUT.offsetOf('owner'),
          bytes: ownerAddress.toBase58(),
        },
      },
      {
        dataSize: OPEN_ORDERS_LAYOUT.span,
      },
    ];
    const accounts = await getFilteredProgramAccounts(
      connection,
      DEX_PROGRAM_ID,
      filters,
    );
    return accounts.map(({ publicKey, accountInfo }) =>
      OpenOrders.fromAccountInfo(publicKey, accountInfo),
    );
  }

  static async load(connection: Connection, address: PublicKey) {
    const accountInfo = await connection.getAccountInfo(address);
    if (accountInfo === null) {
      throw new Error('Open orders account not found');
    }
    return OpenOrders.fromAccountInfo(address, accountInfo);
  }

  static fromAccountInfo(address: PublicKey, accountInfo: AccountInfo<Buffer>) {
    const { owner, data } = accountInfo;
    if (!owner.equals(DEX_PROGRAM_ID)) {
      throw new Error('Address not owned by program');
    }
    const decoded = OPEN_ORDERS_LAYOUT.decode(data);
    if (!decoded.accountFlags.initialized || !decoded.accountFlags.openOrders) {
      throw new Error('Invalid open orders account');
    }
    return new OpenOrders(address, decoded);
  }

  static async makeCreateAccountTransaction(
    connection: Connection,
    marketAddress: PublicKey,
    ownerAddress: PublicKey,
    newAccountAddress: PublicKey,
  ) {
    return SystemProgram.createAccount({
      fromPubkey: ownerAddress,
      newAccountPubkey: newAccountAddress,
      lamports: await connection.getMinimumBalanceForRentExemption(
        OPEN_ORDERS_LAYOUT.span,
      ),
      space: OPEN_ORDERS_LAYOUT.span,
      programId: DEX_PROGRAM_ID,
    });
  }

  get publicKey() {
    return this.address;
  }
}

export const ORDERBOOK_LAYOUT = struct([
  accountFlagsLayout('accountFlags'),
  SLAB_LAYOUT.replicate('slab'),
]);

export class Orderbook {
  market: Market;
  isBids: boolean;
  slab: Slab;

  constructor(market: Market, accountFlags, slab: Slab) {
    if (!accountFlags.initialized || !(accountFlags.bids ^ accountFlags.asks)) {
      throw new Error('Invalid orderbook');
    }
    this.market = market;
    this.isBids = accountFlags.bids;
    this.slab = slab;
  }

  static decode(market: Market, buffer: Buffer) {
    const { accountFlags, slab } = ORDERBOOK_LAYOUT.decode(buffer);
    return new Orderbook(market, accountFlags, slab);
  }

  getL2(depth: number): [number, number, BN, BN][] {
    const descending = this.isBids;
    const levels: [BN, BN][] = []; // (price, size)
    for (const { key, quantity } of this.slab.items(descending)) {
      const price = getPriceFromKey(key);
      if (levels.length > 0 && levels[levels.length - 1][0].eq(price)) {
        levels[levels.length - 1][1].iadd(quantity);
      } else if (levels.length === depth) {
        break;
      } else {
        levels.push([price, quantity]);
      }
    }
    return levels.map(([priceLots, sizeLots]) => [
      this.market.priceLotsToNumber(priceLots),
      this.market.baseSizeLotsToNumber(sizeLots),
      priceLots,
      sizeLots,
    ]);
  }

  *[Symbol.iterator]() {
    for (const { key, ownerSlot, owner, quantity } of this.slab) {
      const price = getPriceFromKey(key);
      yield {
        orderId: key,
        ownerSlot,
        owner,
        price: this.market.priceLotsToNumber(price),
        priceLots: price,
        size: this.market.baseSizeLotsToNumber(quantity),
        sizeLots: quantity,
        side: this.isBids ? 'buy' : 'sell',
      };
    }
  }
}

function getPriceFromKey(key) {
  return key.ushrn(64);
}

function divideBnToNumber(numerator: BN, denominator: BN): number {
  const quotient = numerator.div(denominator).toNumber();
  const rem = numerator.umod(denominator);
  const gcd = rem.gcd(denominator);
  return quotient + rem.div(gcd).toNumber() / denominator.div(gcd).toNumber();
}

const MINT_LAYOUT = struct([blob(36), u8('decimals'), blob(3)]);

export async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
): Promise<number> {
  const { data } = throwIfNull(
    await connection.getAccountInfo(mint),
    'mint not found',
  );
  const { decimals } = MINT_LAYOUT.decode(data);
  return decimals;
}

async function getFilteredProgramAccounts(
  connection: Connection,
  programId: PublicKey,
  filters,
): Promise<{ publicKey: PublicKey; accountInfo: AccountInfo<Buffer> }[]> {
  // @ts-ignore
  const resp = await connection._rpcRequest('getProgramAccounts', [
    programId.toBase58(),
    {
      commitment: connection.commitment,
      filters,
      encoding: 'binary64',
    },
  ]);
  if (resp.error) {
    throw new Error(resp.error.message);
  }
  return resp.result.map(
    ({ pubkey, account: { data, executable, owner, lamports } }) => ({
      publicKey: new PublicKey(pubkey),
      accountInfo: {
        data: Buffer.from(data, 'base64'),
        executable,
        owner: new PublicKey(owner),
        lamports,
      },
    }),
  );
}

function throwIfNull<T>(value: T | null, message = 'account not found'): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}
