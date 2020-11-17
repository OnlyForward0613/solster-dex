import React, { PropsWithChildren, ReactElement } from 'react';
import { Link } from 'react-router-dom';
import AppBar from '@material-ui/core/AppBar';
import Toolbar from '@material-ui/core/Toolbar';
import IconButton from '@material-ui/core/IconButton';
import Typography from '@material-ui/core/Typography';
import Container from '@material-ui/core/Container';
import { WalletConnectButton } from './components/Wallet';

type Props = {};

export default function Layout(props: PropsWithChildren<Props>) {
  return (
    <React.Fragment>
      <Nav>{props.children}</Nav>
    </React.Fragment>
  );
}

function Nav(props: PropsWithChildren<Props>): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <AppBar position="static">
        <Toolbar>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              width: '100%',
            }}
          >
            <Link to={'/'} style={{ color: 'inherit', textDecoration: 'none' }}>
              <div style={{ display: 'flex' }}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    marginRight: '12px',
                  }}
                >
                  <img
                    style={{
                      display: 'block',
                      height: '35px',
                    }}
                    alt="Logo"
                    src="http://dex.projectserum.com/static/media/logo.49174c73.svg"
                  />
                </div>
                <IconButton color="inherit" edge="start">
                  <Typography variant="h6">Lockup</Typography>
                </IconButton>
              </div>
            </Link>
            <div
              style={{
                display: 'flex',
              }}
            >
              <WalletConnectButton />
            </div>
          </div>
        </Toolbar>
      </AppBar>
      <Container fixed maxWidth="md">
        <div style={{ marginTop: '24px', marginBottom: '24px' }}>
          {props.children}
        </div>
      </Container>
    </div>
  );
}
