# CloudFusion Node (headless)

The first headless CLI milestone pairs a NAS/Linux installation to a CloudFusion account without collecting the account password. It creates one stable Ed25519 libp2p identity per installation and redeems a short-lived, one-use pairing code.

## Pair and inspect

1. Apply API migration `1735000000000-DevicePairingCodes`.
2. In the signed-in CloudFusion web app, open **Dispositivos** and generate a pairing code.
3. On the NAS, run:

   ```sh
   cargo run --release --manifest-path apps/node/Cargo.toml -- login --api https://cloudfusion.example
   ```

4. Enter the code when prompted. It is not included in shell history or printed by the CLI. Pairing codes expire after five minutes and can be used once.
5. Check registration with `cloudfusion-node status`. Revoke the node from the CloudFusion device-management page or run `cloudfusion-node logout`.

Use `http://localhost:3000` only for a local development API. Remote API addresses must use HTTPS. Do not expose the API pairing code to anyone else.

## Credential storage

The CLI stores the rotating device refresh token and Ed25519 private identity in `~/.config/cloudfusion-node/node.json` (or `$XDG_CONFIG_HOME/cloudfusion-node/node.json`) on Linux, and `%APPDATA%\CloudFusion\node.json` on Windows. On Unix the default configuration directory is restricted to mode `0700` and the credential file to `0600`; symlink credential files are rejected, and files with broader permissions cannot be used. If `CLOUDFUSION_NODE_CONFIG` overrides the location, the file remains `0600` but the operator is responsible for protecting its parent directory. The file is never intended for the repository. Set `CLOUDFUSION_NODE_CONFIG` to use a separate credential file for another node identity.

This milestone intentionally provides pairing, status, and logout only. It does not yet claim to run continuous folder synchronization, serve P2P file chunks, or act as a relay. Those commands will be enabled after the headless service reuses the Desktop's ticket checks, verified-file index, and `/cloudfusion/file-chunk/1` protocol.
