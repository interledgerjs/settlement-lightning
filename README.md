# Interledger Lightning Plugin

[![NPM Package](https://img.shields.io/npm/v/ilp-plugin-lightning.svg?style=flat)](https://npmjs.org/package/ilp-plugin-lightning)
[![CircleCI](https://img.shields.io/circleci/project/github/interledgerjs/ilp-plugin-lightning.svg)](https://circleci.com/gh/interledgerjs/ilp-plugin-lightning)
[![Codecov](https://img.shields.io/codecov/c/github/interledgerjs/ilp-plugin-lightning.svg)](https://codecov.io/gh/interledgerjs/ilp-plugin-lightning)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Apache 2.0 License](https://img.shields.io/github/license/interledgerjs/ilp-plugin-lightning.svg)](https://github.com/interledgerjs/ilp-plugin-lightning/blob/master/LICENSE)

:rotating_light: **Expect breaking changes while this plugin is in beta.**

## Overview

`ilp-plugin-lightning` enables settlements between Interledger peers using the [Lightning Network](https://lightning.network/) on Bitcoin. Using the [ILP/Stream](https://github.com/interledger/rfcs/blob/master/0029-stream/0029-stream.md) protocol, payments are chunked down into small increments, which can facilitate faster and more relaible payments compared with native Lightning!

The integration requires an existing Lightning node with connectivity to the greater Lightning network. Note that speed within the Lightning network degrades as two peers have more degrees of separation, and opening a direct channel provides a much faster experience.

Additional information on the Lightning Network is available [here](https://dev.lightning.community/).

## Install

```bash
npm install ilp-plugin-lightning
```

Requires Node.js v8.10+.

## API

Here are the available options to pass to the plugin. Additional configuration options are also inherited from [ilp-plugin-btp](https://github.com/interledgerjs/ilp-plugin-btp) if the plugin is a client, and [ilp-plugin-mini-accounts](https://github.com/interledgerjs/ilp-plugin-mini-accounts) if the plugin is a server.

#### `role`

- Type:
  - `"client"` to connect to a single counterparty
  - `"server"` enables multiple counterparties to connect
- Default: `"client"`

#### `lnd`

- **Required**
- Type: `LndOpts` or `LndService`
- Credentials to create a connection to the LND node, or an already constructed LND service

To have the plugin create the connection internally, provide an object with the following properties:

##### `macaroon`

- **Required**
- Type: `string` or `Buffer`
- LND macaroon to used authenticate daemon requests as a Base64-encoded string or Buffer (e.g. using `fs.readFile`)

##### `tlsCert`

- **Required**
- Type: `string` or `Buffer`
- TLS certificate to authenticate the connection to the Lightning daemon as a Base64-encoded string or Buffer (e.g. using `fs.readFile`)

##### `hostname`

- **Required**
- Type: `string`
- Hostname of the Lightning node

##### `grpcPort`

- Type: `number`
- Default: `10009`
- Port of LND gRPC server

Alternatively, the LND client can be created externally using the same options and injected into the plugin:

```js
import LightningPlugin, { connectLnd } from 'ilp-plugin-lightning'

const lnd = connectLnd({
  hostname: 'localhost',
  macaroon:
    'AgEDbG5kArsBAwoQ3/I9f6kgSE6aUPd85lWpOBIBMBoWCgdhZGRyZXNzEgRyZWFkEgV3cml0ZRoTCgRpbmZvEgRyZWFkEgV32ml0ZRoXCghpbnZvaWNlcxIEcmVhZBIFd3JpdGUaFgoHbWVzc2FnZRIEcmVhZBIFd3JpdGUaFwoIb2ZmY2hhaW4SBHJlYWQSBXdyaXRlGhYKB29uY2hhaW4SBHJlYWQSBXdyaXRlGhQKBXBlZXJzEgRyZWFkEgV3cml0ZQAABiAiUTBv3Eh6iDbdjmXCfNxp4HBEcOYNzXhrm+ncLHf5jA==',
  tlsCert:
    'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNpRENDQWkrZ0F3SUJBZ0lRZG81djBRQlhIbmppNGhSYWVlTWpOREFLQmdncWhrak9QUVFEQWpCSE1SOHcKSFFZRFZRUUtFeFpzYm1RZ1lYVjBiMmRsYm1WeVlYUmxaQ0JqWlhKME1TUXdJZ1lEVlFRREV4dEtkWE4wZFhOegpMVTFoWTBKdmIyc3RVSEp2TFRNdWJHOWpZV3d3SGhjTk1UZ3dPREl6TURVMU9ERXdXaGNOTVRreE1ERTRNRFUxCk9ERXdXakJITVI4d0hRWURWUVFLRXhac2JtUWdZWFYwYjJkbGJtVnlZWFJsWkNCalpYSjBNU1F3SWdZRFZRUUQKRXh0S2RYTjBkWE56TFUxaFkwSnZiMnN0VUhKdkxUTXViRzlqWVd3d1dUQVRCZ2NxaGtqT1BRSUJCZ2dxaGtpTwpQUU1CQndOQ0FBU0ZoUm0rdy9UMTBQb0t0ZzRsbTloQk5KakpENDczZmt6SHdQVUZ3eTkxdlRyUVNmNzU0M2oyCkpyZ0ZvOG1iVFYwVnRwZ3FrZksxSU1WS01MckYyMXhpbzRIOE1JSDVNQTRHQTFVZER3RUIvd1FFQXdJQ3BEQVAKQmdOVkhSTUJBZjhFQlRBREFRSC9NSUhWQmdOVkhSRUVnYzB3Z2NxQ0cwcDFjM1IxYzNNdFRXRmpRbTl2YXkxUQpjbTh0TXk1c2IyTmhiSUlKYkc5allXeG9iM04wZ2dSMWJtbDRnZ3AxYm1sNGNHRmphMlYwaHdSL0FBQUJoeEFBCkFBQUFBQUFBQUFBQUFBQUFBQUFCaHhEK2dBQUFBQUFBQUFBQUFBQUFBQUFCaHhEK2dBQUFBQUFBQUF3bGM5WmMKazdiRGh3VEFxQUVFaHhEK2dBQUFBQUFBQUJpTnAvLytHeFhHaHhEK2dBQUFBQUFBQUtXSjV0bGlET1JqaHdRSwpEd0FDaHhEK2dBQUFBQUFBQUc2V3ovLyszYXRGaHhEOTJ0RFF5djRUQVFBQUFBQUFBQkFBTUFvR0NDcUdTTTQ5CkJBTUNBMGNBTUVRQ0lBOU85eHRhem1keENLajBNZmJGSFZCcTVJN0pNbk9GUHB3UlBKWFFmcllhQWlCZDVOeUoKUUN3bFN4NUVDblBPSDVzUnB2MjZUOGFVY1hibXlueDlDb0R1ZkE9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg=='
})

const plugin = new LightningPlugin({
  lnd
  // (Pass other config options here)
})
```

#### `maxPacketAmount`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum amount in _satoshis_ above which an incoming ILP packet should be rejected

#### `balance`

The balance (positive) is the net amount the counterparty/peer owes an instance of the plugin. A negative balance implies the plugin owes money to the counterparty.

Contrary to other plugins that require the balance middleware in [ilp-connector](https://github.com/interledgerjs/ilp-connector/) to trigger settlement, here, all the balance configuration is internal to the plugin. `sendMoney` is a no-operation on the server (but _may_ be used on the client if triggering settlements manually is preferred).

Thus, pre-funding—sending money to the peer _before_ forwarding packets through them—requires a positive `settleTo` amount, and post-funding—settling _after_ forwarding packets through them—requires a 0 or negative `settleTo` amount.

All the following balance options are in units of _satoshis_.

##### `maximum`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum balance the counterparty owes this instance before further balance additions are rejected (e.g. settlements and forwarding of PREPARE packets with debits that increase balance above maximum the would be rejected)
- Must be greater than or equal to settleTo amount

##### `settleTo`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `0`
- Settlement attempts will increase the balance to this amount
- Must be greater than or equal to settleThreshold

##### `settleThreshold`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `-Infinity`
- Automatically attempts to settle when the balance drops below this threshold (exclusive)
- By default, auto settlement is disabled, and the plugin is in receive-only mode
- Must be greater than or equal to the minimum balance

##### `minimum`

- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `-Infinity`
- Maximum this instance owes the counterparty before further balance subtractions are rejected (e.g. incoming money/claims and forwarding of FULFILL packets with credits that reduce balance below minimum would be rejected)

## Bilateral Communication

This plugin uses the [Bilateral Transfer Protocol](https://github.com/interledger/rfcs/blob/master/0023-bilateral-transfer-protocol/0023-bilateral-transfer-protocol.md) over WebSockets to send messages between peers. Two subprotocols are supported:

#### `peeringRequest`

- Format: `[Identity public key]@[hostname]:[port]`, UTF-8 encoded
- Used for sharing peering information of our Lightning node with the peer
- The receiver of the message will subsequently attempt to peer over the Lightning network

#### `paymentRequest`

- Format: [BOLT11](https://github.com/lightningnetwork/lightning-rfc/blob/master/11-payment-encoding.md) encoded, then UTF-8 encoded
- Used to send a invoice to the Interledger peer, so they have the ability to send payments to our instance
- By default, peers send 20 invoices ahead of time, and share an additional invoice as each invoice expires or is paid

## Known Issues

- LND does not currently support pruning invoices (neither automatically nor manually). As this plugin may generate several invoices per second when a peer is actively streaming money, this can significantly increase the footprint of the LND database.
- LND may soon support [spontaneous payments](https://github.com/lightningnetwork/lnd/pull/2455), which would eliminate the overhead of frequently sharing invoices.
- The plugin does not perform any accounting for Lightning Network fees.
