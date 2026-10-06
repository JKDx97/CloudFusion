# P2P coordination API

This module is the control plane for peer transfers. The server keeps file-version metadata, a short lease saying which device claims to have a local copy, and transfer state. It never stores a desktop path or file bytes.

## Current endpoints

- `GET /p2p/privacy` returns the account-wide P2P permission; `PATCH /p2p/privacy` accepts `{ "enabled": boolean }`. Disabling withdraws all of that user's active availability advertisements and cancels active peer-transfer sessions involving the account.
- `POST /p2p/availability` advertises the exact readable `nodeId`/`versionId` for the authenticated device. The client supplies its locally computed SHA-256 and byte size; the API accepts the advertisement only when both match the server-owned `FileVersion` metadata.
- `GET /p2p/availability?nodeId=…&versionId=…` returns only unexpired advertisements whose devices still permit serving and whose users still have read permission.
- `DELETE /p2p/availability/:nodeId/:versionId` withdraws the current device's advertisement.
- `POST /p2p/transfers/authorize` takes a source device and exact file version and issues a signed, one-use ticket.
- `POST /p2p/transfers/:id/claim` consumes the ticket only on its named source device and rechecks both device sessions, revocation, version and read permissions.
- `GET /p2p/transfers/:id`, `POST /p2p/transfers/:id/state`, and `POST /p2p/transfers/:id/cancel` are scoped to the two participating device sessions.

Viewer/read access is sufficient for a download. This includes cross-user Workspace or resource-share access: the destination and source users are checked independently by the permission engine, and the checks are repeated when the source claims the ticket. Public-link transfers deliberately do not use personal devices as sources. A receiver alone can advance a session to `VERIFYING`/`COMPLETED`, and completion requires the exact authorized byte count. The Desktop receiver also verifies the full SHA-256 before it marks a transfer complete. mDNS only contributes temporary routes; neither LAN presence nor an account-local peer list grants transfer authorization. The account-wide privacy gate is checked when advertising, discovering, authorizing, claiming, and updating transfers, so a device-level opt-in cannot override an account-level opt-out. Disabling P2P does not disable ordinary cloud uploads/downloads or device storage replication; it only stops device-to-device discovery and transfer.

## Configuration

- `P2P_TRANSFER_TICKET_TTL_SECONDS` — signed ticket lifetime; clamped to 30–300 seconds, default 120.
- `P2P_AVAILABILITY_TTL_SECONDS` — local-copy advertisement lease; clamped to 60–3600 seconds, default 900.
- `P2P_MAX_CONCURRENT_TRANSFERS` — active sessions per device; clamped to 1–16, default 4.

The `1734000000000-PeerTransferCoordination` migration creates the availability and session tables and required indexes. Apply migrations before using these endpoints; ORM synchronization remains disabled. No migration has been run against a developer database automatically.

The `1739000000000-GlobalP2pPrivacy` migration adds the default-enabled account-level privacy flag. Apply it before deploying API/web/Desktop builds that use `/p2p/privacy`.

## Desktop data plane

- Desktop only serves a file found in its bounded local index, after confirming the source path, size, modification time, and SHA-256 still match the advertised version.
- A transfer requires the API's one-use ticket. The serving device rechecks the live API session while sending.
- Content is exchanged in bounded blocks (at most 256 KiB per request); the receiver checks offsets, byte counts, version metadata, and SHA-256, flushes the temporary file, then atomically renames it into place. An existing destination is not overwritten on a failed or unverifiable transfer.
- Interrupted receives keep a hidden partial beside the selected destination, keyed by the authorized content hash. Retrying the same version in the same folder resumes from the partial's locally re-read length with a fresh one-use transfer ticket; the complete SHA-256 is still required before the final rename. Invalid full partials are reset rather than installed.
- Desktop reports the observed LAN/direct-P2P/relay route. The Drive version action tries advertised authorized peers in route order and falls back to the permission-checked CloudFusion download if none succeeds.

## Windows desktop support and limits

- The supported Phase 9 desktop target is Windows. Desktop sync folders upload local changes into a selected CloudFusion Drive folder, preserve remote conflicts, and advertise verified local copies for P2P when the device allows serving files. Downloads prefer authorized peers and keep the verified CloudFusion download as fallback. This is cloud-coordinated folder sync with peer-assisted transfers, not bidirectional peer sync; local deletions are intentionally not propagated. Availability leases renew while Desktop is running and expire server-side when a device goes offline.
- The headless/NAS client and Linux/macOS support are outside the current Windows delivery and remain deferred. The API accepts bounded batches of up to 500 availability records (rate-limited) for large local sync roots. Relay service code and a local circuit integration test are included, but operators must deploy the relay and configure its device allowlist and address; no public managed relay is provisioned by CloudFusion.

The web fallback is a normal browser download; it does not currently continue into the Desktop-selected P2P destination.
