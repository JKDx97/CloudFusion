# CloudFusion Node (headless)

The headless CLI pairs a NAS or other always-on computer to CloudFusion without collecting the account password. It creates one stable Ed25519 libp2p identity per installation and redeems a short-lived, one-use pairing code. It can also continuously synchronize configured local folders with **CloudFusion Drive**.

## Pair and inspect

1. Apply API migration `1735000000000-DevicePairingCodes`.
2. In the signed-in CloudFusion web app, open **Dispositivos** and generate a pairing code.
3. On the NAS, run:

   ```sh
   cargo run --release --manifest-path apps/node/Cargo.toml -- login --api https://cloudfusion.example
   ```

4. Enter the code when prompted. It is not included in shell history or printed by the CLI. Pairing codes expire after five minutes and can be used once.
5. Check registration with `cloudfusion-node status`. Revoke the node from the CloudFusion device-management page or run `cloudfusion-node logout`.

## Configure and run folder sync

Create or choose a folder in CloudFusion Drive and copy its folder UUID. On the node, add the local folder:

```sh
cloudfusion-node sync add --path /srv/cloudfusion --remote-node-id <folder-uuid>
cloudfusion-node sync list
cloudfusion-node start
```

`start` runs an initial sync, then checks for changes about every 30 seconds until Ctrl+C. Local additions and edits are uploaded; remote versions are downloaded after their size and SHA-256 are verified. Concurrent edits are preserved as conflict copies. Symbolic links and unsafe paths are skipped or rejected. File deletions are deliberately not propagated yet, so removing a configured root does not delete its local contents or cloud files. Run `cloudfusion-node sync remove --root-id <root-uuid>` to unlink a local root.

The node can also serve verified local versions to other registered CloudFusion devices over the existing `/cloudfusion/file-chunk/1` protocol. In **Dispositivos**, enable **P2P**, **Compartir archivos locales**, and either **Descubrimiento LAN** or **P2P por Internet**. The node checks its device settings itself, trusts only active P2P-enabled devices on the account, claims a one-use API ticket before sending, verifies the local SHA-256, and checks the transfer state while serving. Availability leases are renewed in bounded batches every five minutes; stopped nodes become unavailable when their leases expire. LAN discovery uses mDNS/QUIC. Internet relay participation requires `CLOUDFUSION_RELAY_MULTIADDR` to contain the configured relay multiaddress ending in `/p2p/<relay-peer-id>` and the device's relay option to be enabled.

When a remote version is needed, the node checks CloudFusion's permission-filtered availability list and tries up to eight connected or relay-routable sources, preferring LAN/direct paths. It uses a one-use device-bound ticket, validates each response, reports progress, and verifies the complete size and SHA-256 before installation. If no peer can deliver the exact version, sync falls back to the existing authenticated CloudFusion download. Receiving works even when this node is not allowed to serve its own files. A packaged Linux/NAS release and relay infrastructure provisioning remain follow-up work. P2P remains opt-in and disabled by default.

Use `http://localhost:3000` only for a local development API. Remote API addresses must use HTTPS. Do not expose the API pairing code to anyone else.

## Credential storage

The CLI stores the rotating device refresh token and Ed25519 private identity in `~/.config/cloudfusion-node/node.json` (or `$XDG_CONFIG_HOME/cloudfusion-node/node.json`) on Linux, and `%APPDATA%\CloudFusion\node.json` on Windows. On Unix the default configuration directory is restricted to mode `0700` and the credential file to `0600`; symlink credential files are rejected, and files with broader permissions cannot be used. If `CLOUDFUSION_NODE_CONFIG` overrides the location, the file remains `0600` but the operator is responsible for protecting its parent directory. The file is never intended for the repository. Set `CLOUDFUSION_NODE_CONFIG` to use a separate credential file for another node identity.

The separate `sync-manifest.json` stores only local/remote relative paths and version/checksum metadata alongside the credential file; on Unix it is restricted to owner-only permissions. Do not place the node configuration directory in a shared location. The service never logs access/refresh tokens or private keys.
