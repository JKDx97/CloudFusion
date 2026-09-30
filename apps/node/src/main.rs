use base64::{engine::general_purpose::STANDARD, Engine};
use libp2p::identity::Keypair;
use reqwest::{header, Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

mod mesh;
mod sync;

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const MAX_CONFIG_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeConfig {
    pub(crate) api_url: String,
    pub(crate) installation_id: String,
    pub(crate) name: String,
    pub(crate) peer_id: String,
    pub(crate) peer_public_key: String,
    pub(crate) peer_private_key: String,
    #[serde(default)]
    pub(crate) device_id: Option<String>,
    #[serde(default)]
    pub(crate) refresh_token: Option<String>,
    #[serde(default)]
    pub(crate) sync_roots: Vec<sync::NodeSyncRoot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest<'a> {
    code: &'a str,
    device: PairDevice<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairDevice<'a> {
    installation_id: &'a str,
    name: &'a str,
    platform: &'static str,
    client_version: &'static str,
    peer_id: &'a str,
    peer_public_key: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshRequest<'a> {
    refresh_token: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthSession {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) device_id: String,
}

#[derive(Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiDevice {
    id: String,
    name: String,
    platform: String,
    peer_id: Option<String>,
    p2p_enabled: bool,
    lan_discovery_enabled: bool,
    internet_p2p_enabled: bool,
    relay_allowed: bool,
    serve_local_files: bool,
    storage_contribution_enabled: bool,
    revoked_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoutReceipt {
    logged_out: bool,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("cloudfusion-node: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let Some(command) = args.next() else {
        return Err(usage());
    };
    match command.as_str() {
        "login" => {
            let api_url = parse_api_argument(args)?;
            login(&api_url).await
        }
        "status" => {
            ensure_no_arguments(args)?;
            status().await
        }
        "logout" => {
            ensure_no_arguments(args)?;
            logout().await
        }
        "sync" => sync::run_command(args).await,
        "start" => {
            ensure_no_arguments(args)?;
            sync::run_daemon().await
        }
        "--help" | "-h" | "help" => {
            println!("{}", usage());
            Ok(())
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "Usage:\n  cloudfusion-node login --api <https://cloudfusion.example/api>\n  cloudfusion-node status\n  cloudfusion-node sync add --path <local-folder> --remote-node-id <folder-uuid>\n  cloudfusion-node sync list\n  cloudfusion-node sync remove --root-id <root-uuid>\n  cloudfusion-node start\n  cloudfusion-node logout\n\nPair the node with a short-lived code created from CloudFusion > Dispositivos.\n`start` runs background synchronization; P2P file serving is opt-in in Dispositivos and requires an active local sync copy.".to_owned()
}

fn parse_api_argument(mut args: impl Iterator<Item = String>) -> Result<String, String> {
    let mut api = None;
    while let Some(argument) = args.next() {
        if argument == "--api" {
            if api.is_some() {
                return Err("Specify --api only once".to_owned());
            }
            api = Some(args.next().ok_or_else(usage)?);
        } else {
            return Err(usage());
        }
    }
    validate_api_url(api.as_deref().ok_or_else(usage)?)
}

fn ensure_no_arguments(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    if args.next().is_some() {
        Err(usage())
    } else {
        Ok(())
    }
}

fn validate_api_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = Url::parse(trimmed).map_err(|_| "The API URL is invalid".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "The API URL must be an HTTP(S) base address without credentials or query parameters"
                .to_owned(),
        );
    }
    if parsed.scheme() != "https"
        && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
    {
        return Err(
            "Use HTTPS for a remote CloudFusion API; plain HTTP is allowed only on this computer"
                .to_owned(),
        );
    }
    Ok(trimmed.to_owned())
}

async fn login(api_url: &str) -> Result<(), String> {
    let mut config = match load_config() {
        Ok(config) => config,
        Err(error) if error == "Node is not paired" => {
            let config = new_config(api_url)?;
            save_config(&config)?;
            config
        }
        Err(error) => return Err(error),
    };
    if config.api_url != api_url {
        return Err("This installation already has an identity for a different API. Use logout first or configure a separate node path.".to_owned());
    }

    eprint!("One-time CloudFusion pairing code: ");
    io::stderr()
        .flush()
        .map_err(|_| "Could not read the pairing code".to_owned())?;
    let mut code = String::new();
    io::stdin()
        .read_line(&mut code)
        .map_err(|_| "Could not read the pairing code".to_owned())?;
    let code = normalize_pairing_code(&code)?;

    let keypair = Keypair::from_protobuf_encoding(
        &STANDARD
            .decode(&config.peer_private_key)
            .map_err(|_| "The saved node identity is invalid".to_owned())?,
    )
    .map_err(|_| "The saved node identity is invalid".to_owned())?;
    let public_key = STANDARD.encode(keypair.public().encode_protobuf());
    if keypair.public().to_peer_id().to_string() != config.peer_id
        || public_key != config.peer_public_key
    {
        return Err("The saved node identity failed its integrity check".to_owned());
    }

    let client = build_client()?;
    let request = PairRequest {
        code: &code,
        device: PairDevice {
            installation_id: &config.installation_id,
            name: &config.name,
            platform: "NAS",
            client_version: CLIENT_VERSION,
            peer_id: &config.peer_id,
            peer_public_key: &config.peer_public_key,
        },
    };
    let session: AuthSession =
        post_json(&client, &config.api_url, "/auth/device-pair", &request).await?;
    validate_session(&session)?;
    config.device_id = Some(session.device_id);
    config.refresh_token = Some(session.refresh_token);
    save_config(&config)?;
    println!("Paired successfully.");
    println!(
        "Device: {} ({})",
        config.name,
        config.device_id.as_deref().unwrap_or_default()
    );
    println!("Peer ID: {}", config.peer_id);
    println!("Credential file: {}", config_path()?.display());
    println!("No token or private key was printed.");
    Ok(())
}

async fn status() -> Result<(), String> {
    let mut config = load_config()?;
    let client = build_client()?;
    let session = refresh_session(&client, &mut config).await?;
    let devices: Vec<ApiDevice> =
        get_json(&client, &config.api_url, "/devices", &session.access_token).await?;
    let device = devices
        .into_iter()
        .find(|device| device.id == session.device_id)
        .ok_or_else(|| "This node is no longer registered. It may have been revoked.".to_owned())?;
    if device.revoked_at.is_some() {
        return Err("This node has been revoked".to_owned());
    }
    if device.platform != "NAS" || device.peer_id.as_deref() != Some(config.peer_id.as_str()) {
        return Err(
            "The registered device identity does not match this node's local identity".to_owned(),
        );
    }
    println!("CloudFusion node status: paired");
    println!("API: {}", config.api_url);
    println!("Device: {} ({})", device.name, device.platform);
    println!("Device ID: {}", device.id);
    println!(
        "Peer ID: {}",
        device.peer_id.as_deref().unwrap_or("not registered")
    );
    println!("P2P enabled: {}", device.p2p_enabled);
    println!("LAN discovery: {}", device.lan_discovery_enabled);
    println!("Internet P2P: {}", device.internet_p2p_enabled);
    println!("Relay allowed: {}", device.relay_allowed);
    println!("Serving local files: {}", device.serve_local_files);
    println!(
        "Storage contribution: {}",
        device.storage_contribution_enabled
    );
    println!("Configured sync roots: {}", config.sync_roots.len());
    Ok(())
}

async fn logout() -> Result<(), String> {
    let mut config = load_config()?;
    let client = build_client()?;
    let session = refresh_session(&client, &mut config).await?;
    let receipt: LogoutReceipt = post_authorized_json(
        &client,
        &config.api_url,
        "/auth/logout",
        &session.access_token,
        &(),
    )
    .await?;
    if !receipt.logged_out {
        return Err("The API did not confirm revocation of the node session".to_owned());
    }
    config.refresh_token = None;
    save_config(&config)?;
    println!("The CloudFusion node session was revoked. Its installation and peer identity were retained.");
    Ok(())
}

pub(crate) async fn refresh_session(
    client: &Client,
    config: &mut NodeConfig,
) -> Result<AuthSession, String> {
    let refresh_token = config
        .refresh_token
        .as_deref()
        .ok_or_else(|| "Node is not paired; run cloudfusion-node login first".to_owned())?;
    let request = RefreshRequest { refresh_token };
    let session: AuthSession =
        post_json(client, &config.api_url, "/auth/refresh", &request).await?;
    validate_session(&session)?;
    if config
        .device_id
        .as_deref()
        .is_some_and(|device_id| device_id != session.device_id)
    {
        return Err("The API returned a session for a different device identity".to_owned());
    }
    config.device_id = Some(session.device_id.clone());
    config.refresh_token = Some(session.refresh_token.clone());
    save_config(config)?;
    Ok(session)
}

fn validate_session(session: &AuthSession) -> Result<(), String> {
    if session.access_token.trim().is_empty()
        || session.access_token.len() > 16_384
        || session.refresh_token.trim().is_empty()
        || session.refresh_token.len() > 16_384
        || Uuid::parse_str(&session.device_id).is_err()
    {
        return Err("CloudFusion API returned invalid node-session credentials".to_owned());
    }
    Ok(())
}

pub(crate) fn build_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("cloudfusion-node/{CLIENT_VERSION}"))
        .build()
        .map_err(|_| "Could not initialize the CloudFusion API client".to_owned())
}

async fn post_json<T: Serialize + ?Sized, R: for<'de> Deserialize<'de>>(
    client: &Client,
    api_url: &str,
    path: &str,
    body: &T,
) -> Result<R, String> {
    let url = format!("{}{}", api_url, path);
    let response = client
        .post(url)
        .header(header::CONTENT_TYPE, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|_| "Could not reach the CloudFusion API".to_owned())?;
    parse_response(response).await
}

async fn post_authorized_json<T: Serialize + ?Sized, R: for<'de> Deserialize<'de>>(
    client: &Client,
    api_url: &str,
    path: &str,
    access_token: &str,
    body: &T,
) -> Result<R, String> {
    let url = format!("{}{}", api_url, path);
    let response = client
        .post(url)
        .bearer_auth(access_token)
        .header(header::CONTENT_TYPE, "application/json")
        .json(body)
        .send()
        .await
        .map_err(|_| "Could not reach the CloudFusion API".to_owned())?;
    parse_response(response).await
}

pub(crate) async fn get_json<R: for<'de> Deserialize<'de>>(
    client: &Client,
    api_url: &str,
    path: &str,
    access_token: &str,
) -> Result<R, String> {
    let url = format!("{}{}", api_url, path);
    let response = client
        .get(url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "Could not reach the CloudFusion API".to_owned())?;
    parse_response(response).await
}

async fn parse_response<R: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<R, String> {
    if !response.status().is_success() {
        return Err(format!(
            "CloudFusion API request failed ({})",
            response.status()
        ));
    }
    response
        .json::<ApiEnvelope<R>>()
        .await
        .map(|envelope| envelope.data)
        .map_err(|_| "CloudFusion API returned an unexpected response".to_owned())
}

fn normalize_pairing_code(value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('-', "").to_ascii_uppercase();
    if normalized.len() != 32 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Pairing code must contain exactly 32 hexadecimal characters".to_owned());
    }
    Ok(normalized)
}

fn new_config(api_url: &str) -> Result<NodeConfig, String> {
    let keypair = Keypair::generate_ed25519();
    let peer_public_key = STANDARD.encode(keypair.public().encode_protobuf());
    let name = env::var("CLOUDFUSION_NODE_NAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("HOSTNAME")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            env::var("COMPUTERNAME")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "CloudFusion NAS Node".to_owned());
    let safe_host_name: String = name
        .trim()
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect();
    let name = if safe_host_name.is_empty() {
        "CloudFusion NAS Node".to_owned()
    } else if safe_host_name == "CloudFusion NAS Node" {
        safe_host_name
    } else {
        format!("{safe_host_name} (CloudFusion NAS)")
    };
    Ok(NodeConfig {
        api_url: api_url.to_owned(),
        installation_id: Uuid::new_v4().to_string(),
        name,
        peer_id: keypair.public().to_peer_id().to_string(),
        peer_public_key,
        peer_private_key: STANDARD.encode(
            keypair
                .to_protobuf_encoding()
                .map_err(|_| "Could not create the node's cryptographic identity".to_owned())?,
        ),
        device_id: None,
        refresh_token: None,
        sync_roots: Vec::new(),
    })
}

pub(crate) fn load_config() -> Result<NodeConfig, String> {
    load_config_from(&config_path()?)
}

fn load_config_from(path: &Path) -> Result<NodeConfig, String> {
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err("Node is not paired".to_owned());
        }
        Err(_) => return Err("Could not read the node credential file".to_owned()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err("The node credential path is not a safe regular file".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(format!(
                "Node credentials are accessible by other users; restrict permissions on {} to owner-only (0600)",
                path.display()
            ));
        }
    }
    let bytes = fs::read(path).map_err(|_| "Could not read the node credential file".to_owned())?;
    serde_json::from_slice(&bytes).map_err(|_| "The node credential file is invalid".to_owned())
}

pub(crate) fn save_config(config: &NodeConfig) -> Result<(), String> {
    let path = config_path()?;
    save_config_to(
        &path,
        config,
        env::var_os("CLOUDFUSION_NODE_CONFIG").is_none(),
    )
}

fn save_config_to(path: &Path, config: &NodeConfig, secure_parent: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create the node configuration directory".to_owned())?;
    let parent_metadata = fs::symlink_metadata(parent)
        .map_err(|_| "Could not inspect the node configuration directory".to_owned())?;
    if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
        return Err("The node configuration directory is not a safe directory".to_owned());
    }
    #[cfg(unix)]
    if secure_parent {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Could not secure the node configuration directory".to_owned())?;
    }
    #[cfg(not(unix))]
    let _ = secure_parent;
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("The node credential path is not a safe regular file".to_owned());
        }
    }

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| "Could not determine the node credential file name".to_owned())?;
    let temporary = parent.join(format!(
        ".{}.tmp-{}",
        file_name.to_string_lossy(),
        Uuid::new_v4()
    ));
    let bytes =
        serde_json::to_vec(config).map_err(|_| "Could not encode node credentials".to_owned())?;
    let write_result = (|| -> io::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        #[cfg(unix)]
        {
            OpenOptions::new().read(true).open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("Could not securely save the node credential file".to_owned());
    }
    Ok(())
}

pub(crate) fn config_path() -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("CLOUDFUSION_NODE_CONFIG") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(windows)]
    {
        let base = env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "APPDATA is not configured".to_owned())?;
        return Ok(base.join("CloudFusion").join("node.json"));
    }
    #[cfg(not(windows))]
    {
        let base = env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
            .ok_or_else(|| "Neither XDG_CONFIG_HOME nor HOME is configured".to_owned())?;
        Ok(base.join("cloudfusion-node").join("node.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        load_config_from, normalize_pairing_code, save_config_to, validate_api_url, NodeConfig,
    };
    use std::{env, fs};
    use uuid::Uuid;

    #[test]
    fn pairing_code_accepts_api_grouping_without_weakening_validation() {
        assert_eq!(
            normalize_pairing_code("01234567-89abcdef-01234567-89abcdef").unwrap(),
            "0123456789ABCDEF0123456789ABCDEF"
        );
        assert!(normalize_pairing_code("0123-not-a-code").is_err());
        assert!(normalize_pairing_code("0123456789abcdef0123456789abcdeg").is_err());
    }

    #[test]
    fn remote_api_requires_https_and_local_http_has_no_credentials() {
        assert!(validate_api_url("https://api.example.test/v1/").is_ok());
        assert!(validate_api_url("http://localhost:3000").is_ok());
        assert!(validate_api_url("http://api.example.test").is_err());
        assert!(validate_api_url("https://user:secret@api.example.test").is_err());
        assert!(validate_api_url("https://api.example.test?token=secret").is_err());
    }

    #[test]
    fn node_credentials_can_be_atomically_rotated_and_stay_private() {
        let directory = env::temp_dir().join(format!("cloudfusion-node-test-{}", Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("node.json");
        let mut config = NodeConfig {
            api_url: "https://api.example.test".to_owned(),
            installation_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            name: "Test NAS".to_owned(),
            peer_id: "test-peer".to_owned(),
            peer_public_key: "public".to_owned(),
            peer_private_key: "private-secret".to_owned(),
            device_id: Some("device-id".to_owned()),
            refresh_token: Some("initial-token".to_owned()),
            sync_roots: Vec::new(),
        };
        save_config_to(&path, &config, true).unwrap();
        assert_eq!(
            load_config_from(&path).unwrap().refresh_token.as_deref(),
            Some("initial-token")
        );
        config.refresh_token = Some("rotated-token".to_owned());
        save_config_to(&path, &config, true).unwrap();
        assert_eq!(
            load_config_from(&path).unwrap().refresh_token.as_deref(),
            Some("rotated-token")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&directory).unwrap();
    }
}
