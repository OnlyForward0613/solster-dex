import React, {
  Context,
  PropsWithChildren,
  ReactElement,
  ReactNode,
  useEffect,
  useMemo,
  useContext,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import Button from '@material-ui/core/Button';
import { useSnackbar } from 'notistack';

import { State as StoreState } from '../store/reducer';
import { ActionType } from '../store/actions';
// @ts-ignore
import Wallet from '@project-serum/sol-wallet-adapter';
import { Client } from '@project-serum/lockup';
import { Connection, PublicKey } from '@solana/web3.js';
import * as bs58 from 'bs58';
import * as BufferLayout from 'buffer-layout';
import { TokenInstructions } from '@project-serum/serum';

export function useWallet(): WalletContextValues {
  const w = useContext(WalletContext);
  if (!w) {
    throw new Error('Missing wallet context');
  }
  return w;
}

const WalletContext = React.createContext<null | WalletContextValues>(null);

type WalletContextValues = {
  wallet: Wallet;
  client: Client;
};

export function WalletProvider(
  props: PropsWithChildren<ReactNode>,
): ReactElement {
  const { walletProvider, networkUrl } = useSelector((state: StoreState) => {
    return {
      walletProvider: state.walletProvider,
      networkUrl: state.networkUrl,
    };
  });
  const wallet = useMemo(() => new Wallet(walletProvider, networkUrl), [
    walletProvider,
    networkUrl,
  ]);

  const client = useMemo(() => Client.devnet(wallet), [wallet]);

  return (
    <WalletContext.Provider value={{ wallet, client }}>
      {props.children}
    </WalletContext.Provider>
  );
}

export function WalletConnectButton(): ReactElement {
  const isConnected = useSelector(
    (state: StoreState) => state.walletIsConnected,
  );
  const dispatch = useDispatch();
  const { wallet, client } = useWallet();

  const { enqueueSnackbar, closeSnackbar } = useSnackbar();

  useEffect(() => {
    wallet.on('disconnect', () => {
      dispatch({
        type: ActionType.WalletIsConnected,
        item: { walletIsConnected: false },
      });
      enqueueSnackbar('Disconnected from wallet');
    });
  }, [wallet]);

  const fetchOwnedTokenAccounts = async () => {
    const ownedTokenAccounts = await getOwnedTokenAccounts(
      client.provider.connection,
      wallet.publicKey,
    );
    dispatch({
      type: ActionType.OwnedTokenAccountsSet,
      item: {
        ownedTokenAccounts,
      },
    });
    console.log('OWNED', ownedTokenAccounts);
  };

  const connect = () => {
    enqueueSnackbar('Connecting to wallet...');
    wallet.once('connect', () => {
      closeSnackbar();
      dispatch({
        type: ActionType.WalletIsConnected,
        item: {
          walletIsConnected: true,
        },
      });
      enqueueSnackbar(
        `Connectection established ${wallet.publicKey.toBase58()}`,
      );
      fetchOwnedTokenAccounts();
    });
    wallet.connect();
  };

  const disconnect = () => {
    wallet.disconnect();
  };

  return isConnected ? (
    <Button color="inherit" onClick={disconnect}>
      Disconnect
    </Button>
  ) : (
    <Button color="inherit" onClick={connect}>
      Connect wallet
    </Button>
  );
}

export async function getOwnedTokenAccounts(
  connection: Connection,
  publicKey: PublicKey,
) {
  let filters = getOwnedAccountsFilters(publicKey);
  // @ts-ignore
  let resp = await connection._rpcRequest('getProgramAccounts', [
    TokenInstructions.TOKEN_PROGRAM_ID.toBase58(),
    {
      commitment: connection.commitment,
      filters,
    },
  ]);
  if (resp.error) {
    throw new Error(
      'failed to get token accounts owned by ' +
        publicKey.toBase58() +
        ': ' +
        resp.error.message,
    );
  }
  return (
    resp.result
      // @ts-ignore
      .map(({ pubkey, account: { data, executable, owner, lamports } }) => {
        data = bs58.decode(data);
        return {
          publicKey: new PublicKey(pubkey),
          accountInfo: {
            tokenAccount: parseTokenAccountData(data),
            executable,
            owner: new PublicKey(owner),
            lamports,
          },
        };
      })
  );
}

export const ACCOUNT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(32, 'mint'),
  BufferLayout.blob(32, 'owner'),
  BufferLayout.nu64('amount'),
  BufferLayout.blob(93),
]);

export const MINT_LAYOUT = BufferLayout.struct([
  BufferLayout.blob(44),
  BufferLayout.u8('decimals'),
  BufferLayout.blob(37),
]);

export function parseTokenAccountData(data: any) {
  // @ts-ignore
  let { mint, owner, amount } = ACCOUNT_LAYOUT.decode(data);
  return {
    mint: new PublicKey(mint),
    owner: new PublicKey(owner),
    amount,
  };
}

// @ts-ignore
export function parseMintData(data) {
  // @ts-ignore
  let { decimals } = MINT_LAYOUT.decode(data);
  return { decimals };
}

// @ts-ignore
export function getOwnedAccountsFilters(publicKey) {
  return [
    {
      memcmp: {
        // @ts-ignore
        offset: ACCOUNT_LAYOUT.offsetOf('owner'),
        bytes: publicKey.toBase58(),
      },
    },
    {
      dataSize: ACCOUNT_LAYOUT.span,
    },
  ];
}
