const { readFile, writeFile } = require('fs')
const { promisify } = require('util')
const { resolve } = require('path')

async function run() {
  const path = resolve('./generated/rpc.d.ts')
  promisify(readFile)(path, 'utf8')
    .then(
      data =>
        // Import stream types from grpc-js
        `import { ClientReadableStream, ClientDuplexStream } from "@grpc/grpc-js/build/src/call"\n` +
        data
          // Fix types provide RPC implementation with streaming
          .split('rpcImpl: $protobuf.RPCImpl')
          .join('rpcImpl: $protobuf.RPCImpl | $protobuf.RPCHandler')
          // Change stream types to work with grpc-js
          .split('$protobuf.RPCServerStream')
          .join('ClientReadableStream')
          .split('$protobuf.RPCBidiStream')
          .join('ClientDuplexStream')
    )
    .then(data => promisify(writeFile)(path, data))
}

run().catch(err => console.error(err))
