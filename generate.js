const { readFile, writeFile, mkdir, exists } = require('fs')
const { promisify } = require('util')
const { resolve } = require('path')
const { shell } = require('execa')

async function run() {
  const outDir = resolve('./generated')

  // Create output directory if it doesn't already exist
  if (!(await promisify(exists)(outDir))) {
    await promisify(mkdir)(outDir)
  }

  console.log('Generating proto definitions...')

  // Generate JS via grpc-tools
  await shell(
    `./node_modules/.bin/grpc_tools_node_protoc ` +
      `--plugin="protoc-gen-grpc=./node_modules/.bin/grpc_tools_node_protoc_plugin" ` +
      `--js_out="import_style=commonjs,binary:${outDir}" ` +
      `--grpc_out="${outDir}" ` +
      `--proto_path="./src/proto" ` +
      `--proto_path="./node_modules/protobufjs" ` +
      `./src/proto/*.proto`
  )

  // Generate TypeScript declarations
  await shell(
    `./node_modules/grpc-tools/bin/protoc ` +
      `--plugin="protoc-gen-ts=./node_modules/grpc_tools_node_protoc_ts/bin/protoc-gen-ts" ` +
      `--ts_out="${outDir}" ` +
      `--proto_path="./src/proto" ` +
      `--proto_path="./node_modules/protobufjs" ` +
      `./src/proto/*.proto`
  )

  // Remove unused imports that cause errors
  const removeReference = path =>
    promisify(readFile)(path, 'utf8')
      .then(data =>
        data.replace(
          `var google_api_annotations_pb = require('./google/api/annotations_pb.js');`,
          ''
        )
      )
      .then(data =>
        data.replace(
          `goog.object.extend(proto, google_api_annotations_pb);`,
          ''
        )
      )
      .then(data => promisify(writeFile)(path, data))

  await removeReference(resolve('./generated/rpc_grpc_pb.js'))
  await removeReference(resolve('./generated/rpc_pb.js'))
}

run().catch(err => console.error(err))
