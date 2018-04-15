# ilp-plugin-lnd-asym-server
> Interledger.js Ledger Plugin for the Lightning Network

This plugin enables [Interledger](https://interledger.org) payments through the Bitcoin and Litecoin [Lightning Networks](https://lightning.network).

## Installation

```sh
npm install ilp-plugin-lnd-asym-server
```

## Usage

This plugin can be used with the [`ilp`](https://github.com/interledgerjs/ilp) client module or the [`ilp-connector`](https://github.com/interledgerjs/ilp-connector).
See the [Ledger Plugin Interface v2](https://interledger.org/rfcs/0024-ledger-plugin-interface-2/) for documentation on available methods.

* Connect to the lightning testnet:
```sh
export GOPATH=~/gocode
export PATH=$PATH:$GOPATH/bin
lnd --bitcoin.active --bitcoin.testnet --debuglevel=debug --bitcoin.node=neutrino --neutrino.connect=faucet.lightning.community --datadir=./data --no-macaroons
```

Check your settings in ~/Library/Application\ Support/Lnd/lnd.conf, you can also set options like `--bitcoin.testnet` there instead of on the command line.
* Use lncli to create a wallet, see http://dev.lightning.community/tutorial/01-lncli/ for inspiration on how to do this
```sh
lncli --no-macaroons create
lncli --no-macaroons getinfo
lncli --no-macaroons newaddress np2wkh
lncli --no-macaroons walletbalance witness-only=true
```

Now you can run a server on localhost, using:
```sh
DEBUG=* node scripts/server.js
```

## How It Works

This plugin can be used by two Interledger nodes (sender to connector, connector to connector, and connector to receiver) to send payments through an instance of the Lightning Network. It uses the [Bilateral Transfer Protocol](https://github.com/interledger/rfcs/blob/master/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md), implemented by the [mini-accounts framework](https://github.com/interledgerjs/ilp-plugin-mini-account), to send Interledger payment and quote details that cannot currently be communicated through `lnd` itself. Because of the need for an additional messaging layer, this plugin implementation only works bilaterally at present.
