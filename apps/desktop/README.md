# CloudFusion Desktop

The Tauri desktop shell reuses the Angular client in `apps/web`. It gives each installation a stable identity in the operating system credential store, registers that identity during login/registration, stores the rotating refresh token in Windows Credential Manager, and watches user-selected local folders. Local changes are uploaded to CloudFusion Drive, and remote versions are pulled into sync roots with checksum validation and conflict-safe handling.

The desktop can discover approved devices, establish LAN/direct-P2P/relay routes, and transfer authorized file blocks between trusted peers. The API's one-use tickets and live permission checks remain in force. Transfers use bounded 256 KiB blocks, verify the complete SHA-256, and atomically install only verified files. The Drive action tries available authorized peers and falls back to a permission-checked browser download from CloudFusion.

P2P downloads can resume verified partial data, while peer tickets and live permission checks remain mandatory. The initial headless/NAS CLI is available in `apps/node` for secure pairing, status, and logout; its continuous sync/P2P service is not enabled yet.

## Run on Windows

Install Rust with the MSVC target, Microsoft C++ Build Tools (Desktop development with C++ and a Windows SDK), and the Microsoft Edge WebView2 Runtime. Then, from the repository root:

```powershell
npm --prefix apps/web run build
cargo run --manifest-path apps/desktop/Cargo.toml
```

The API must be running at `http://localhost:3000`. The desktop account should sign in through the app so the backend creates a device-bound session. The credential store and sync journal are kept under the operating system's per-application data directory; no private key or refresh token is written to the repository.
# Internet P2P relay

Desktop can optionally use a CloudFusion Circuit Relay v2 node alongside its LAN mesh. Configure `CLOUDFUSION_RELAY_MULTIADDR` in the Desktop process environment with the relay's public TCP address, ending in `/p2p/<relay-peer-id>`, then restart the app. Leave the variable unset to use LAN discovery only.

See [the relay deployment guide](../relay/README.md) for the allowlist, resource limits, firewall ports and server setup. Relay transfers remain subject to the API-issued one-use ticket and the source device's live permission checks; the encrypted relay carries no stored file data.

## Device storage heartbeat

When storage contribution is enabled for a device in **Settings → Devices**, the running Desktop client reports its aggregate CloudFusion sync-manifest bytes every minute. It counts only local files with a saved version checksum and expected size; only the total is sent to the API, never local paths. A missing sync root or usage above the configured capacity suppresses the heartbeat. Stale device heartbeats become `OFFLINE` after three minutes. This is presence/capacity reporting, not device replica allocation; keep the configured cloud replicas for durability.
