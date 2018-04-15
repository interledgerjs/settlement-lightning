# ilp-plugin-lnd-asym-server
> Interledger.js Ledger Plugin for the Lightning Network

This plugin enables [Interledger](https://interledger.org) payments through the Bitcoin and Litecoin [Lightning Networks](https://lightning.network).

See the [ILP Lightning Demo](https://github.com/interledgerjs/ilp-lightning-demo) or the [example script](./examples/rpc-test.js) to watch this plugin in action.

## Installation

```sh
npm install ilp-plugin-lnd-asym-server
```

## Usage

This plugin can be used with the [`ilp`](https://github.com/interledgerjs/ilp) client module or the [`ilp-connector`](https://github.com/interledgerjs/ilp-connector).
See the [Ledger Plugin Interface v2](https://interledger.org/rfcs/0024-ledger-plugin-interface-2/) for documentation on available methods.

A minimal way to test your setup:
* Set up a local Lightning cluster as explained in http://dev.lightning.community/tutorial/01-lncli/ - but run btcd with `--testnet` instead of `--simnet`
* Then, using the `ALICE_PUBKEY` and `BOB_PUBKEY` from there, try running (for Mac):
```sh
DEBUG=* LND_TLS_CERT_PATH=~/Library/"Application Support"/Lnd/tls.cert ALICE_PUBKEY=036fb00... BOB_PUBKEY=45c2e46... node scripts/test.js
```
or for Linux:
```sh
DEBUG=* LND_TLS_CERT_PATH=~/.lnd/tls.cert ALICE_PUBKEY=036fb00... BOB_PUBKEY=45c2e46... node scripts/test.js
```
* It should output something like the following:
```sh
{ server: 'btp+ws://:pass@localhost:9000',
  maxBalance: '1000000',
  maxUnsecured: '1000',
  lndTlsCertPath: '/Users/michiel/Library/Application Support/Lnd/tls.cert',
  lndUri: 'localhost:10009',
  peerPublicKey: '036fb0045c2e4651995b7e2fe6656fac729087857af56dc75ab48f9769e0a7001f',
  _store: ObjStore { s: {} } }
{ listener: { port: 9000 },
  incomingSecret: 'pass',
  prefix: 'test.crypto.lightning.btc.testnet3.',
  info: {},
  maxBalance: '1000000',
  maxUnsecured: '1000',
  lndTlsCertPath: '/Users/michiel/Library/Application Support/Lnd/tls.cert',
  lndUri: 'localhost:10009',
  peerPublicKey: '036fb0045c2e4651995b7e2fe6656fac729087857af56dc75ab48f9769e0a7001f',
  _store: ObjStore { s: {} } }
connnn... 1
connnn... 2
connnn... 3
connnn... 1
connnn... 2
connnn... 3
Transfer prepared server-side. Condition: L0PV5Khe_vkNV2NIH5Sts8muJYGLb1lDrUEXHsAfPJc
Transfer prepared client-side, waiting for fulfillment...
Transfer executed. Fulfillment: yUu7TlEGuz6es7_UBi7AQGFqP_GOBczSytECWAoc9CI
```

See the [Ledger Plugin Interface](https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md) for documentation on available methods.

## How It Works

This plugin can be used by two Interledger nodes (sender to connector, connector to connector, and connector to receiver) to send payments through an instance of the Lightning Network. It uses the [Bilateral Transfer Protocol](https://github.com/interledger/rfcs/blob/master/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md), implemented by the [payment channel framework](https://github.com/interledgerjs/ilp-plugin-payment-channel-framework), to send Interledger payment and quote details that cannot currently be communicated through `lnd` itself. Because of the need for an additional messaging layer, this plugin implementation only works bilaterally at present.
