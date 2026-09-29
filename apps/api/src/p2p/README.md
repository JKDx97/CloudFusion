# P2P coordination API

This module is the control plane for peer transfers. The server keeps file-version metadata, a short lease saying which device claims to have a local copy, and transfer state. It never stores a desktop path or file bytes.

## Current endpoints

- `POST /p2p/availability` advertises the exact readable `nodeId`/`versionId` for the authenticated device. The client supplies its locally computed SHA-256 and byte size; the API accepts the advertisement only when both match the server-owned `FileVersion` metadata.
- `GET /p2p/availability?nodeId=…&versionId=…` returns only unexpired advertisements whose devices still permit serving and whose users still have read permission.
- `DELETE /p2p/availability/:nodeId/:versionId` withdraws the current device's advertisement.
- `POST /p2p/transfers/authorize` takes a source device and exact file version and issues a signed, one-use ticket.
- `POST /p2p/transfers/:id/claim` consumes the ticket only on its named source device and rechecks both device sessions, revocation, version and read permissions.
- `GET /p2p/transfers/:id`, `POST /p2p/transfers/:id/state`, and `POST /p2p/transfers/:id/cancel` are scoped to the two participating device sessions.

Viewer/read access is sufficient for a download. Public-link transfers deliberately do not use personal devices as sources. A receiver alone can advance a session to `VERIFYING`/`COMPLETED`, and completion requires the exact authorized byte count; final hash verification is still the responsibility of the not-yet-integrated data plane.

## Configuration

- `P2P_TRANSFER_TICKET_TTL_SECONDS` — signed ticket lifetime; clamped to 30–300 seconds, default 120.
- `P2P_AVAILABILITY_TTL_SECONDS` — local-copy advertisement lease; clamped to 60–3600 seconds, default 900.
- `P2P_MAX_CONCURRENT_TRANSFERS` — active sessions per device; clamped to 1–16, default 4.

The `1734000000000-PeerTransferCoordination` migration creates the availability and session tables and required indexes. Apply migrations before using these endpoints; ORM synchronization remains disabled. No migration has been run against a developer database automatically.

## Not implemented yet

The API contract is in place, but Desktop does not yet advertise local file-version mappings, consume tickets, stream content, resume a partial transfer, verify a received hash, or choose LAN/P2P/relay/cloud fallback. The current desktop mesh only discovers approved LAN peers and establishes the secure libp2p transport.
