import { blob, seq, struct, u8 } from 'buffer-layout';
import { accountFlagsLayout, publicKeyLayout, u128, u64 } from './layout';
import { SLAB_LAYOUT } from './slab';
import { DEX_PROGRAM_ID, DexInstructions } from './instructions';
import BN from 'bn.js';
import {
  Account,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';

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
  constructor(decoded, baseMintDecimals, quoteMintDecimals) {
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

  static async load(connection, address) {
    const { owner, data } = await connection.getAccountInfo(address);
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

  get address() {
    return this._decoded.ownAddress;
  }

  get publicKey() {
    return this.address;
  }

  get baseMintAddress() {
    return this._decoded.baseMint;
  }

  get quoteMintAddress() {
    return this._decoded.quoteMint;
  }

  async loadBids(connection) {
    const { data } = await connection.getAccountInfo(this._decoded.bids);
    return Orderbook.decode(this, data);
  }

  async loadAsks(connection) {
    const { data } = await connection.getAccountInfo(this._decoded.asks);
    return Orderbook.decode(this, data);
  }

  async findBaseTokenAccountsForOwner(connection, ownerAddress) {
    return (
      await connection.getTokenAccountsByOwner(ownerAddress, {
        mint: this.baseMintAddress,
      })
    ).value;
  }

  async findQuoteTokenAccountsForOwner(connection, ownerAddress) {
    return (
      await connection.getTokenAccountsByOwner(ownerAddress, {
        mint: this.quoteMintAddress,
      })
    ).value;
  }

  async findOpenOrdersAccountsForOwner(connection, ownerAddress) {
    return OpenOrders.findForMarketAndOwner(
      connection,
      this.address,
      ownerAddress,
    );
  }

  async placeOrder(
    connection,
    { owner, payer, side, price, size, orderType = 'limit' },
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

  async makePlaceOrderTransaction(
    connection,
    { owner, payer, side, price, size, orderType = 'limit' },
  ) {
    const ownerAddress = owner.publicKey ?? owner;
    const openOrdersAccounts = await this.findOpenOrdersAccountsForOwner(
      connection,
      ownerAddress,
    ); // TODO: cache this
    const transaction = new Transaction();
    const signers = [owner];
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

  async cancelOrder(connection, owner, order) {
    const transaction = await this.makeCancelOrderTransaction(
      connection,
      order,
    );
    return await connection.sendTransaction(transaction, [owner]);
  }

  async makeCancelOrderTransaction(connection, order) {
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

  async findOpenOrdersAccountForOrder(connection, order) {
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

  get _baseSplTokenMultiplier() {
    return new BN(10).pow(new BN(this._baseSplTokenDecimals));
  }

  get _quoteSplTokenMultiplier() {
    return new BN(10).pow(new BN(this._quoteSplTokenDecimals));
  }

  priceLotsToNumber(price) {
    return divideBnToNumber(
      price.mul(this._decoded.quoteLotSize).mul(this._baseSplTokenMultiplier),
      this._decoded.baseLotSize.mul(this._quoteSplTokenMultiplier),
    );
  }

  priceNumberToLots(price) {
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

  baseSizeLotsToNumber(size) {
    return divideBnToNumber(
      size.mul(this._decoded.baseLotSize),
      this._baseSplTokenMultiplier,
    );
  }

  baseSizeNumberToLots(size) {
    const native = new BN(
      Math.round(size * Math.pow(10, this._baseSplTokenDecimals)),
    );
    // rounds down to the nearest lot size
    return native.div(this._decoded.baseLotSize);
  }

  quoteSizeLotsToNumber(size) {
    return divideBnToNumber(
      size.mul(this._decoded.quoteLotSize),
      this._quoteSplTokenMultiplier,
    );
  }

  quoteSizeNumberToLots(size) {
    const native = new BN(
      Math.round(size * Math.pow(10, this._quoteSplTokenDecimals)),
    );
    // rounds down to the nearest lot size
    return native.div(this._decoded.quoteLotSize);
  }

  async matchOrders(connection, feePayer, limit) {
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
  constructor(address, decoded) {
    this.address = address;
    Object.assign(this, decoded);
  }

  static get LAYOUT() {
    return OPEN_ORDERS_LAYOUT;
  }

  static async findForMarketAndOwner(connection, marketAddress, ownerAddress) {
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

  static async load(connection, address) {
    const accountInfo = await connection.getAccountInfo(address);
    if (accountInfo === null) {
      throw new Error('Open orders account not found');
    }
    return OpenOrders.fromAccountInfo(connection, accountInfo);
  }

  static fromAccountInfo(address, accountInfo) {
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
    connection,
    marketAddress,
    ownerAddress,
    newAccountAddress,
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
  constructor(market, accountFlags, slab) {
    if (!accountFlags.initialized || !(accountFlags.bids ^ accountFlags.asks)) {
      throw new Error('Invalid orderbook');
    }
    this.market = market;
    this.isBids = accountFlags.bids;
    this.slab = slab;
  }

  static decode(market, buffer) {
    const { accountFlags, slab } = ORDERBOOK_LAYOUT.decode(buffer);
    return new Orderbook(market, accountFlags, slab);
  }

  getL2(depth) {
    const descending = this.isBids;
    const levels = []; // (price, size)
    for (const { key, quantity } of this.slab.items(descending)) {
      const price = getPriceFromKey(key);
      if (levels.length > 0 && levels[levels.length - 1][0].equals(price)) {
        levels[levels.length - 1][1].iadd(quantity);
      } else if (levels.length === depth) {
        break;
      } else {
        levels.push([price, quantity]);
      }
    }
    return levels.map(([priceLots, sizeLots]) => [
      this.market.priceLotsToNumber(priceLots),
      this.market.baseSizeLotsToNumber(sizeLots.mul(this.market.baseLotSize)),
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

function divideBnToNumber(numerator, denominator) {
  const quotient = numerator.div(denominator).toNumber();
  const rem = numerator.umod(denominator);
  const gcd = rem.gcd(denominator);
  return quotient + rem.div(gcd).toNumber() / denominator.div(gcd).toNumber();
}

const MINT_LAYOUT = struct([blob(36), u8('decimals'), blob(3)]);

export async function getMintDecimals(connection, mint) {
  const { data } = await connection.getAccountInfo(mint);
  const { decimals } = MINT_LAYOUT.decode(data);
  return decimals;
}

async function getFilteredProgramAccounts(connection, programId, filters) {
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
