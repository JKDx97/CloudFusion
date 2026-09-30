# CloudFusion Relay v2

This is a standalone Circuit Relay v2 node for CloudFusion Desktop. It is a network relay only: it forwards encrypted libp2p streams and does not persist file contents.

## Configuration

Run the relay on a public Linux VM or other server with a stable public IP. Keep the identity file on persistent private storage; changing or losing it changes the relay peer ID.

Required environment variable:

- `CLOUDFUSION_RELAY_ALLOWED_PEERS`: comma-separated, explicit allowlist of CloudFusion device `peerId` values. Both reservations and circuit sources are rejected unless their peer ID is listed. The relay starts closed if this value is empty or invalid.

Optional environment variables:

- `CLOUDFUSION_RELAY_PORT` (default `4001`): TCP and UDP/QUIC listen port.
- `CLOUDFUSION_RELAY_BIND_IP` (default `0.0.0.0`): local interface to bind.
- `CLOUDFUSION_RELAY_EXTERNAL_IP`: public IP to advertise to libp2p peers.
- `CLOUDFUSION_RELAY_KEY_FILE` (default `relay-key.pb`): persistent Ed25519 identity file. On Unix it is created with owner-only permissions.

The relay allows at most 128 reservations, 2 per device, 32 simultaneous circuits and 2 circuits per device. Each circuit is capped at 64 MiB or 15 minutes. The built-in per-peer and per-IP rate limits remain enabled in addition to the CloudFusion device allowlist.

## Run

```sh
cd apps/relay
CLOUDFUSION_RELAY_ALLOWED_PEERS="<device-peer-id-1>,<device-peer-id-2>" cargo run --release
```

Open the configured port for both TCP and UDP in the host firewall and cloud security group. TCP carries the initial relay control connection; QUIC is available for direct and relay-server transport traffic.

The service prints its stable relay peer ID and listening multiaddresses. On each Desktop, set `CLOUDFUSION_RELAY_MULTIADDR` to a reachable TCP address ending in that peer ID, for example `/ip4/<public-ip>/tcp/4001/p2p/<relay-peer-id>`, then restart CloudFusion Desktop. Both participating devices must be on the allowlist and have Internet P2P enabled. Direct hole punching is attempted automatically; if it fails, the authorized transfer may continue through the bounded relay circuit or the existing cloud path.

The allowlist is an infrastructure-level peer-ID gate, not the transfer authorization mechanism. CloudFusion's API ticket, source claim and read-permission checks remain mandatory before a device serves any file chunk.
