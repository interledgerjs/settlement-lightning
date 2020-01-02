import { startServer, connectRedis } from 'ilp-settlement-core'
import { createEngine } from '.'

async function run() {
  const engine = createEngine({
    port: process.env.LND_GRPC_PORT,
    hostname: process.env.LND_HOSTNAME,
    macaroon: process.env.LND_ADMIN_MACAROON!,
    tlsCert: process.env.LND_TLS_CERT!
  })

  const store = await connectRedis({
    uri: process.env.REDIS_URI,
    db: 1 // URI, if provided, will override this
  })

  const { shutdown } = await startServer(engine, store, {
    connectorUrl: process.env.CONNECTOR_URL,
    port: process.env.ENGINE_PORT
  })

  process.on('SIGINT', async () => {
    await shutdown()

    if (store.disconnect) {
      await store.disconnect()
    }
  })
}

run().catch(err => console.error(err))
