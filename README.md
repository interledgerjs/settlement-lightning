# ilp-plugin-lightning

- [Description](#description)
- [Demo](#demo)
- [Lightning Specific Protocols](#lightning-specific-protocols)
- [API](#api)

## Description

** Still under development, use small amounts of money **

This is a plugin that integrates [Lightning](https://lightning.network/)
to the Interledger network.  Using this plugin, one will be able to
communicate value from the Bitcoin or Litecoin blockchain to any other
currency on the Interledger network.
 
This plugin assumes that a client already has some payment channel 
open, connected to the greater lightning network.  The following versions
will implement the opening and closing of payment channels so that 
users will not need a pre-existing connection to the lightning network.

If you're unfamiliar with lightning, you can learn more about
how it works [here](https://dev.lightning.community/).

## Demo

If you want to run this plugin, you'll need both a lightning and bitcoin node
running.  The easiest way to do this is likely through setting up a local
simnet.  Once you have two entities configured, you can enter their credentials
in `test/test.ts` and run `node ./build/test/test.js` to see a client request an
invoice from a server.

## Lightning Specific Protocols

The main difference between lightning and the previously integrated currencies
(XRP, ETH) are that lightning uses identity public keys (different from public
keys used for the blockchain) and all payments must be sent in response to
invoices.

### Peering Protocol
Once a client establishes a websocket connection to a server, they automatically
attempt to peer over lightning.

#### peeringRequest
- Type: `BTP.MESSAGE`
- Data:
  - lndIdentitypubkey: lightning identity pubkey
  - lndPeeringHost: lightning peering `host:port`

Once the server receives the `BTP.MESSAGE` with sub-protocol `peeringRequest`,
they call `connectPeer` on their lightning daemon using the data in the packet
to identify the client on the lightning network.  The server sends a lightning
peering request that is automatically accepted, and sends back a `BTP.MESSAGE`
packet with sub-protocol peeringResponse.

#### peeringResponse
- Type: `BTP.MESSAGE`
- Data:
  - lndIdentityPubkey: lightning identity pubkey

The client then parses the data from this packet and store the server's
identity public key for reference in the future. Peering requests are 
automatically accepted over lightning. The client does NOT need to perform any
lightning level functionality upon receipt of this packet. 

### Invoice Protocol
When a plugin instance wishes to settle with a counterparty, they must request
an invoice before they can make a payment.

#### invoiceRequest
- Type: `BTP.MESSAGE`
- Data: 
  - amount: amount plugin wishes to pay counterparty

Upon receipt of a `BTP.MESSAGE` packet containing the sub-protocol `invoiceRequest` 
a plugin will create an invoice for the requested amount, and send back a
`BTP.MESSAGE` containing the sub-protocol `invoiceResponse`.

#### invoiceResponse
- Type: `BTP.MESSAGE`
- Data: 
  - paymentRequest: a payment request which can be decoded into an invoice

Upon receipt of a `BTP.MESSAGE` packet containing the sub-protocol
`invoiceResponse` the plugin will perform the following steps:

1. Decode the payment request to an invoice
2. Validate the invoice amount and destination are as expected
3. Fulfill the invoice
4. Update their balance
5. Respond with `BTP.MESSAGE` containing the sub-protocol `invoiceFulfill` 

#### invoiceFulfill
- Type: `BTP.TRANSFER`
- Data:
  - paymentRequest: a payment request to identify the sent invoice

Upon receipt of a `BTP.TRANSFER` packet containing the sub-protocol
`invoiceFulfill` the plugin will:

1. Check their lightning daemon to ensure the specified invoice was actually
   fulfilled
2. Update their balance with the counterparty

## API

### `lndIdentityPubkey`
- **Required**
- Type: `string`
- Identity public key used to identify a user on the lightning network.

### `lndHost`
- **Required**
- Type: `string`
- Format: `host:port`
- Communication host used to communicate with local lightning daemon

### `lndPeeringHost`
- **Required**
- Type: `string`
- Format: `host:port`
- Peering host used to listen for p2p communication

### `macaroonPath`
- Type: `string`
- Path to the `admin.macaroon` used to authenticate lightning daemon requests

### `tlsCertPath`
- Type: `string`
- Path to`tls.cert` 

### `role`
- Type:
  - `"client"` to connect to a single counterparty
  - `"server"` enables multiple counterparties to connect
- Default: `"client"`

### `port`
- Type: `number`
- Only used for server, so that client can connect to through this port

### `server`
- Type: `string`
- Format: `btp+wss://:secret@host:port`
- Only used for client, URI to connect to server

### `maxPacketAmount`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or
  `string`
- Default: `Infinity`
- Maximum number of satoshis in single packet that will be accepted

### `balance`
- Positive balance: counterparty owes plugin money
- Negative balance: plugin owes counterparty money

#### `maximum`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `Infinity`
- Maximum balance the counterparty can owe this instance before further packets
  are rejected

#### `settleTo`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `0`
- Plugin will attempt to settle to this amount after the balance falls below the settleThreshold

#### `settleThreshold`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `-10000`
- Automatically attempts to settle when the balance drops below this number

#### `minimum`
- Type: [`BigNumber`](http://mikemcl.github.io/bignumber.js/), `number`, or `string`
- Default: `-Infinity`
- Maximum this instance owes the counterparty before further packets are
  rejected
