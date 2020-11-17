import React, { ReactNode, useState } from 'react';
import { useSelector } from 'react-redux';
import { Client, networks } from '@project-serum/lockup';
import {
  Provider,
  getTokenAccount,
  sleep,
  createMintAndVault,
  createTokenAccount,
} from '@project-serum/common';
import { PublicKey } from '@solana/web3.js';
// @ts-ignore
import Wallet from '@project-serum/sol-wallet-adapter';
import TextField from '@material-ui/core/TextField';
import Button from '@material-ui/core/Button';
import FormControl from '@material-ui/core/FormControl';
import InputLabel from '@material-ui/core/InputLabel';
import Select from '@material-ui/core/Select';
import FormHelperText from '@material-ui/core/FormHelperText';
import MenuItem from '@material-ui/core/MenuItem';
import Typography from '@material-ui/core/Typography';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import { State as StoreState } from '../store/reducer';

export default function NewVesting() {
  const defaultEndDate = '2027-01-01';
  const defaultEndTs = new Date(defaultEndDate).getTime() / 1000;

  const [beneficiary, setBeneficiary] = useState('');
  const isValidBeneficiary = (() => {
    try {
      new PublicKey(beneficiary);
      return true;
    } catch (_) {
      return false;
    }
  })();
  const displayBeneficiaryError = !isValidBeneficiary && beneficiary !== '';

  const [fromAccount, setFromAccount] = useState('');
  console.log('from Acc', fromAccount);
  const [timestamp, setTimestamp] = useState(defaultEndTs);
  const [periodCount, setPeriodCount] = useState(7);
  const [amountStr, setAmountStr] = useState('');
  // @ts-ignore
  const isValidAmountStr = !isNaN(amountStr) && amountStr !== '';
  const displayAmountError = !isValidAmountStr && amountStr !== '';
  const amount = parseInt(amountStr);

  // TODO: don't hardcode srm filter.
  const srmMint = networks.devnet.srm;
  const ownedTokenAccounts = useSelector((state: StoreState) =>
    state.ownedTokenAccounts.filter(
      ota =>
        ota.accountInfo.tokenAccount.mint.toString() === srmMint.toString(),
    ),
  );

  console.log('networks', networks.devnet.god.toString());

  const isValidOwnedTokenAccounts = ownedTokenAccounts.length > 0;

  const submitBtnEnabled =
    isValidBeneficiary && isValidAmountStr && isValidOwnedTokenAccounts;

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h4" component="h2">
          New Vesting Account
        </Typography>
        <div
          style={{
            marginTop: '24px',
          }}
        >
          <FormControl fullWidth>
            <InputLabel id="demo-simple-select-helper-label">From</InputLabel>
            <Select
              fullWidth
              value={fromAccount}
              onChange={e => setFromAccount(e.target.value as string)}
            >
              {ownedTokenAccounts.map(ownedTokenAccount => {
                return (
                  <MenuItem value={ownedTokenAccount.publicKey.toString()}>
                    <div
                      style={{
                        width: '100%',
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>{`${ownedTokenAccount.publicKey}`}</div>
                      <div
                        style={{ float: 'right', color: '#ccc' }}
                      >{`${ownedTokenAccount.accountInfo.tokenAccount.amount}`}</div>
                    </div>
                  </MenuItem>
                );
              })}
            </Select>
            <FormHelperText>Token account to send from</FormHelperText>
          </FormControl>
        </div>
        <div style={{ marginTop: '24px' }}>
          <TextField
            fullWidth
            error={displayBeneficiaryError}
            helperText={displayBeneficiaryError && 'Invalid beneficiary'}
            label="Beneficiary"
            value={beneficiary}
            onChange={e => setBeneficiary(e.target.value)}
          />
          <FormHelperText>Owner of the new vesting account</FormHelperText>
        </div>
        <div
          style={{
            marginTop: '24px',
          }}
        >
          <TextField
            error={displayAmountError}
            helperText={displayAmountError && 'Invalid amount'}
            fullWidth
            label="Amount"
            value={amountStr}
            onChange={e => setAmountStr(e.target.value)}
          />
          <FormHelperText>
            Amount to deposit into the vesting account
          </FormHelperText>
        </div>
        <div
          style={{
            marginTop: '24px',
          }}
        >
          <TextField
            fullWidth
            label="End date"
            type="date"
            defaultValue={defaultEndDate}
            InputLabelProps={{
              shrink: true,
            }}
            onChange={e => {
              const d = new Date(e.target.value);
              setTimestamp(d.getTime() / 1000);
            }}
          />
          <FormHelperText>Date when all tokens are vested</FormHelperText>
        </div>
        <div
          style={{
            marginTop: '24px',
          }}
        >
          <FormControl fullWidth>
            <InputLabel id="demo-simple-select-helper-label">
              Periods
            </InputLabel>
            <Select
              fullWidth
              labelId="demo-simple-select-helper-label"
              id="demo-simple-select-helper"
              value={periodCount}
              onChange={e => setPeriodCount(e.target.value as number)}
            >
              <MenuItem value={1}>1</MenuItem>
              <MenuItem value={2}>2</MenuItem>
              <MenuItem value={3}>3</MenuItem>
              <MenuItem value={4}>4</MenuItem>
              <MenuItem value={5}>5</MenuItem>
              <MenuItem value={6}>6</MenuItem>
              <MenuItem value={7}>7</MenuItem>
              <MenuItem value={8}>8</MenuItem>
              <MenuItem value={9}>9</MenuItem>
              <MenuItem value={10}>10</MenuItem>
            </Select>
            <FormHelperText>Number of vesting periods</FormHelperText>
          </FormControl>
        </div>
        <div>
          <Button
            variant="contained"
            color="primary"
            style={{
              marginTop: '24px',
              float: 'right',
              marginBottom: '24px',
            }}
            disabled={!submitBtnEnabled}
          >
            Create
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

async function testLockup() {
  const wallet = new Wallet(
    'https://www.sollet.io',
    'https://devnet.solana.com',
  );
  wallet.on('connect', async () => {
    const client = Client.devnet(wallet);
    const safe = await client.accounts.safe();
    console.log('Safe', safe);
  });
  wallet.on('disconnect', () => {
    console.log('wallet disconnected');
  });
  wallet.connect();
  wallet.on('disconnect', () => {
    console.log('wallet disconnected');
  });
  wallet.connect();
}
