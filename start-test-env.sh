# Remove running containers
docker stop alice bob btcd
docker rm alice bob btcd

# Show output and fail fast on errors
# set -x -e

export NETWORK="simnet"

# Download LND v0.8.0
rm -rf ./lnd
git clone https://github.com/lightningnetwork/lnd.git
cd ./lnd
git checkout v0.8.0-beta
cd ./docker

# Create Alice's LND node & wait for RPC server to startup
export ALICE_GRPC_PORT="10009"
docker-compose run --detach --publish $ALICE_GRPC_PORT:10009 --name alice lnd_btc --rpclisten=0.0.0.0:10009 --externalip=alice
sleep 10

# TODO Requires jq installed in current environment
export MINING_ADDRESS="$(
  # Generate a new backwards-compatible nested p2sh address for Alice
  docker exec alice lncli --network="$NETWORK" newaddress np2wkh | jq -r '.address'
)"

# Recreate "btcd" node and set Alice's address as mining address
docker-compose up -d btcd

# Generate 400 blocks (> 100 blocks required for coinbase block maturity and > 300 to activate segwit):
docker-compose run btcctl generate 400

# Create Bob's LND node & wait for RPC server to startup
export BOB_GRPC_PORT="10010"
docker-compose run --detach --publish $BOB_GRPC_PORT:10009 --name bob lnd_btc --rpclisten=0.0.0.0:10009 --externalip=bob
sleep 10

BOB_IDENTITY_PUBKEY=$(
  docker exec bob lncli --network=$NETWORK getinfo | jq -r '.identity_pubkey'
)

# Peer Alice's node with Bob's node
docker exec alice lncli --network=$NETWORK connect $BOB_IDENTITY_PUBKEY@bob

# Open Alice -> Bob channel
sleep 10 # Wait for Alice to sync to the chain
docker exec alice lncli --network=$NETWORK openchannel --node_key=$BOB_IDENTITY_PUBKEY --local_amt=10000000

# Include funding transaction in block thereby opening the channel
docker-compose run btcctl generate 3

# Export crednetials to connect over gRPC
export ALICE_ADMIN_MACAROON="$(
  docker exec alice cat /root/.lnd/data/chain/bitcoin/simnet/admin.macaroon | base64
)"
export ALICE_TLS_CERT="$(
  docker exec alice cat /root/.lnd/tls.cert | base64
)"
export BOB_ADMIN_MACAROON="$(
  docker exec bob cat /root/.lnd/data/chain/bitcoin/simnet/admin.macaroon | base64
)"
export BOB_TLS_CERT="$(
  docker exec bob cat /root/.lnd/tls.cert | base64
)"

# Return to previous working dir
cd ../..
