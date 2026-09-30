# Headless device pairing

An authenticated CloudFusion session can authorize one headless device without sharing the user's password:

1. `POST /auth/device-pairing-codes` with the current bearer token returns a one-time 128-bit code. It expires after five minutes.
2. The node sends `POST /auth/device-pair` with that code and its installation metadata (`installationId`, `name`, `platform`, and its libp2p public identity).
3. A successful exchange registers the device and returns a device-bound access/refresh session. The node must keep the refresh token in the operating-system credential store.

The API stores only a SHA-256 digest of each code. Redemption is a conditional database update, so only one concurrent request can consume it. Invalid, expired, and reused codes share the same response. The pairing and exchange routes have tighter request throttles than the global API limit. Pairing codes and tokens must never be written to logs.

Apply migration `1735000000000-DevicePairingCodes` before enabling these endpoints. The API does not run schema synchronization automatically.
