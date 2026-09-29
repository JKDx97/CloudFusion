# CloudFusion Desktop

The Tauri desktop shell reuses the Angular client in `apps/web`. It gives each installation a stable identity in the operating system credential store, registers that identity during login/registration, stores the rotating refresh token in Windows Credential Manager, and watches user-selected local folders.

The desktop can discover same-account devices that explicitly enable LAN discovery and P2P, and establish authenticated QUIC connections to those trusted peers. mDNS only discovers endpoints; peer identities are registered and validated by the API. Local filesystem changes are recorded in a bounded journal and emitted to the UI, but **file contents are not synchronized or uploaded peer-to-peer yet**. The next milestone must define authorized change transfer, conflict handling, and recovery before any content is exchanged.

## Run on Windows

Install Rust with the MSVC target, Microsoft C++ Build Tools (Desktop development with C++ and a Windows SDK), and the Microsoft Edge WebView2 Runtime. Then, from the repository root:

```powershell
npm --prefix apps/web run build
cargo run --manifest-path apps/desktop/Cargo.toml
```

The API must be running at `http://localhost:3000`. The desktop account should sign in through the app so the backend creates a device-bound session. The credential store and sync journal are kept under the operating system's per-application data directory; no private key or refresh token is written to the repository.
