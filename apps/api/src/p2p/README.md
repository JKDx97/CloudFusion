# P2P coordination API

This module is the control plane for peer transfers. The server keeps file-version metadata, a short lease saying which device claims to have a local copy, and transfer state. It never stores a desktop path or file bytes.

## Current endpoints

- `POST /p2p/availability` advertises the exact readable `nodeId`/`versionId` for the authenticated device. The client supplies its locally computed SHA-256 and byte size; the API accepts the advertisement only when both match the server-owned `FileVersion` metadata.
- `GET /p2p/availability?nodeId=…&versionId=…` returns only unexpired advertisements whose devices still permit serving and whose users still have read permission.
- `DELETE /p2p/availability/:nodeId/:versionId` withdraws the current device's advertisement.
- `POST /p2p/transfers/authorize` takes a source device and exact file version and issues a signed, one-use ticket.
- `POST /p2p/transfers/:id/claim` consumes the ticket only on its named source device and rechecks both device sessions, revocation, version and read permissions.
- `GET /p2p/transfers/:id`, `POST /p2p/transfers/:id/state`, and `POST /p2p/transfers/:id/cancel` are scoped to the two participating device sessions.

Viewer/read access is sufficient for a download. Public-link transfers deliberately do not use personal devices as sources. A receiver alone can advance a session to `VERIFYING`/`COMPLETED`, and completion requires the exact authorized byte count. The Desktop receiver also verifies the full SHA-256 before it marks a transfer complete.

## Configuration

- `P2P_TRANSFER_TICKET_TTL_SECONDS` — signed ticket lifetime; clamped to 30–300 seconds, default 120.
- `P2P_AVAILABILITY_TTL_SECONDS` — local-copy advertisement lease; clamped to 60–3600 seconds, default 900.
- `P2P_MAX_CONCURRENT_TRANSFERS` — active sessions per device; clamped to 1–16, default 4.

The `1734000000000-PeerTransferCoordination` migration creates the availability and session tables and required indexes. Apply migrations before using these endpoints; ORM synchronization remains disabled. No migration has been run against a developer database automatically.

## Desktop data plane

- Desktop only serves a file found in its bounded local index, after confirming the source path, size, modification time, and SHA-256 still match the advertised version.
- A transfer requires the API's one-use ticket. The serving device rechecks the live API session while sending.
- Content is exchanged in bounded blocks (at most 256 KiB per request); the receiver checks offsets, byte counts, version metadata, and SHA-256, flushes the temporary file, then atomically renames it into place. An existing destination is not overwritten on a failed or unverifiable transfer.
- Desktop reports the observed LAN/direct-P2P/relay route. The Drive version action tries advertised authorized peers in route order and falls back to the permission-checked CloudFusion download if none succeeds.

## Remaining work

- Resuming a partial P2P transfer is not implemented; a failed receive removes its temporary partial file and a retry starts from byte zero.
- Local folder watchers currently index and journal changes, but do not yet synchronize those changes bidirectionally with CloudFusion or another device, nor resolve conflicts.
- A headless/NAS deployment mode and background service lifecycle are not implemented.

The web fallback is a normal browser download; it does not currently continue into the Desktop-selected P2P destination.
