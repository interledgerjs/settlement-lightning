# Interledger Lightning Settlement Engine ⚡

> Settle Interledger payments using the Bitcoin Lightning Network

[![NPM Package](https://img.shields.io/npm/v/ilp-settlement-lightning.svg?style=flat-square&logo=npm)](https://npmjs.org/package/ilp-settlement-lightning)
[![CircleCI](https://img.shields.io/circleci/project/github/interledgerjs/settlement-lightning/master.svg?style=flat-square&logo=circleci)](https://circleci.com/gh/interledgerjs/settlement-lightning/master)
[![Codecov](https://img.shields.io/codecov/c/github/interledgerjs/settlement-lightning/master.svg?style=flat-square&logo=codecov)](https://codecov.io/gh/interledgerjs/settlement-lightning)
[![Prettier](https://img.shields.io/badge/code_style-prettier-brightgreen.svg?style=flat-square)](https://prettier.io/)
[![Apache 2.0 License](https://img.shields.io/github/license/interledgerjs/settlement-lightning.svg?style=flat-square)](https://github.com/interledgerjs/settlement-lightning/blob/master/LICENSE)

## Install

```bash
npm i -g ilp-settlement-lightning
```

## Usage

Requires Node.js v10+. **For development, Node v12 is currently unsupported.**

```bash
ilp-settlement-lightning
```

### Configuration

- **`CONNECTOR_URL`**: URL of the connector's server dedicated to this settlement engine.
  - Default: `http://localhost:7771`
- **`ENGINE_PORT`**: Port of the settlement engine server exposed to the connector (e.g. for triggering automated settlements).
  - Default: `3000`
- **`REDIS_URI`**: URI to communicate with Redis, typically in the format `redis://[:PASSWORD@]HOST[:PORT][/DATABASE]`.
  - Default: `127.0.0.1:6379/1` (database index of 1 instead of 0)
  - Note: this settlement engine **must** use a unique Redis database index (or dedicated Redis instance) for security to prevent conflicting with the connector.
- **`DEBUG`**: Pattern for printing debug logs. To view logs, `settlement*` is recommended.

### Connect to custom LND instance

To connect to an existing LND node (on mainnet, testnet, or a local simnet), configure the following environment variables:

#### **`LND_ADMIN_MACAROON`**

- **Required**
- LND macaroon to used authenticate daemon requests, as a base64-encoded string

#### **`LND_TLS_CERT`**

- **Required**
- TLS certificate to authenticate the connection to LND's gRPC server, as a base64-encoded string

#### **`LND_HOSTNAME`**

- Default: `localhost`
- Hostname of the Lightning node

#### **`LND_GRPC_PORT`**

- Default: `10009`
- Port of LND gRPC server

## Roadmap

- [ ] Bundle an LND node using Neutrino to remove the external LND node requirement
- [ ] Investigate and improve LND latency (currently ~200ms per payment in integration tests with near zero network latency)
- [ ] Add autopilot options for Interledger peers to automatically negotitate fees to request or supply new incoming capacity
- [ ] Leverage [Atomic Multi-Path Payment specification](https://github.com/lightningnetwork/lightning-rfc/pull/658) for spontaneous payments when it becomes available
- [ ] Add logic to account for Lightning Network fees
- [ ] Support c-Lightning
