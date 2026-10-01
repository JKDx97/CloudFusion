use crate::{sync, NodeConfig};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::StreamExt;
use libp2p::{
    dcutr, identify,
    identity::Keypair,
    mdns,
    multiaddr::Protocol,
    noise, relay,
    request_response::{self, Message, ProtocolSupport},
    swarm::{behaviour::toggle::Toggle, NetworkBehaviour, StreamProtocol, SwarmEvent},
    yamux, Multiaddr, PeerId, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    str::FromStr,
    time::{Duration, Instant, SystemTime},
};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

const TRANSFER_PROTOCOL: &str = "/cloudfusion/file-chunk/1";
const MAX_CHUNK_BYTES: u32 = 256 * 1024;
const MAX_SOURCE_TRANSFERS: usize = 4;
const SOURCE_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const API_POLL_INTERVAL: Duration = Duration::from_secs(30);
const AVAILABILITY_RENEW_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug)]
pub(crate) struct MeshCredentials {
    pub(crate) api_url: String,
    pub(crate) access_token: String,
}

pub(crate) struct MeshCommand {
    peer_id: PeerId,
    request: ChunkRequest,
    response: oneshot::Sender<Result<ChunkResponse, String>>,
}

#[derive(Clone)]
pub(crate) struct MeshHandle {
    sender: mpsc::Sender<MeshCommand>,
    connected_peers: std::sync::Arc<std::sync::RwLock<HashSet<String>>>,
    transfer_paths: std::sync::Arc<std::sync::RwLock<HashMap<String, String>>>,
    relay_configured: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl MeshHandle {
    pub(crate) fn channel() -> (Self, mpsc::Receiver<MeshCommand>) {
        let (sender, receiver) = mpsc::channel(32);
        (
            Self {
                sender,
                connected_peers: std::sync::Arc::default(),
                transfer_paths: std::sync::Arc::default(),
                relay_configured: std::sync::Arc::default(),
            },
            receiver,
        )
    }

    fn is_peer_connected(&self, peer_id: &PeerId) -> bool {
        self.connected_peers
            .read()
            .is_ok_and(|peers| peers.contains(&peer_id.to_string()))
    }

    fn record_peer_connection(&self, peer_id: &PeerId, transport: &str) {
        if let Ok(mut peers) = self.connected_peers.write() {
            peers.insert(peer_id.to_string());
        }
        if let Ok(mut paths) = self.transfer_paths.write() {
            paths.insert(peer_id.to_string(), transport.to_owned());
        }
    }

    fn remove_peer_connection(&self, peer_id: &PeerId) {
        if let Ok(mut peers) = self.connected_peers.write() {
            peers.remove(&peer_id.to_string());
        }
        if let Ok(mut paths) = self.transfer_paths.write() {
            paths.remove(&peer_id.to_string());
        }
    }

    fn transfer_path(&self, peer_id: &PeerId) -> String {
        self.transfer_paths
            .read()
            .ok()
            .and_then(|paths| paths.get(&peer_id.to_string()).cloned())
            .unwrap_or_else(|| "P2P_DIRECT".to_owned())
    }

    fn can_attempt_relay(&self) -> bool {
        self.relay_configured
            .load(std::sync::atomic::Ordering::Acquire)
    }

    async fn request_chunk(
        &self,
        peer_id: PeerId,
        request: ChunkRequest,
    ) -> Result<ChunkResponse, String> {
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(MeshCommand {
                peer_id,
                request,
                response,
            })
            .await
            .map_err(|_| "The local P2P mesh is not running".to_owned())?;
        receiver
            .await
            .map_err(|_| "The P2P peer did not return a response".to_owned())?
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct DeviceSettings {
    id: String,
    peer_id: Option<String>,
    p2p_enabled: bool,
    lan_discovery_enabled: bool,
    internet_p2p_enabled: bool,
    relay_allowed: bool,
    serve_local_files: bool,
    revoked_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimReceipt {
    source_peer_id: String,
    destination_peer_id: String,
    content_hash: String,
    total_bytes: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchAvailabilityReceipt {
    results: Vec<BatchAvailabilityResult>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchAvailabilityResult {
    node_id: String,
    version_id: String,
    advertised: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AvailablePeer {
    device_id: String,
    peer_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferAuthorization {
    transfer: PeerTransferSession,
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PeerTransferSession {
    id: String,
    source_device_id: String,
    destination_device_id: String,
    node_id: String,
    version_id: String,
    content_hash: String,
    total_bytes: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizePeerTransfer<'a> {
    source_device_id: &'a str,
    node_id: &'a str,
    version_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerTransferState<'a> {
    status: &'a str,
    transport: &'a str,
    bytes_transferred: String,
}

pub(crate) async fn download_from_available_peer(
    client: &reqwest::Client,
    api_url: &str,
    access_token: &str,
    destination_device_id: &str,
    node_id: &str,
    version_id: &str,
    expected_hash: &str,
    expected_size: u64,
    destination: &std::path::Path,
    mesh: &MeshHandle,
) -> Result<bool, String> {
    if Uuid::parse_str(destination_device_id).is_err()
        || Uuid::parse_str(node_id).is_err()
        || Uuid::parse_str(version_id).is_err()
        || expected_hash.len() != 64
        || !expected_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("P2P sync metadata is invalid".to_owned());
    }

    let mut availability_url = reqwest::Url::parse(&format!(
        "{}/p2p/availability",
        api_url.trim_end_matches('/')
    ))
    .map_err(|_| "CloudFusion API address is invalid".to_owned())?;
    availability_url
        .query_pairs_mut()
        .append_pair("nodeId", node_id)
        .append_pair("versionId", version_id);
    let response = client
        .get(availability_url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|_| "Could not query CloudFusion P2P availability".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "CloudFusion rejected the P2P availability query ({})",
            response.status()
        ));
    }
    let envelope = response
        .json::<ApiEnvelope<Vec<AvailablePeer>>>()
        .await
        .map_err(|_| "CloudFusion returned invalid P2P availability".to_owned())?;
    let mut peers = envelope
        .data
        .into_iter()
        .filter_map(|peer| {
            if peer.device_id == destination_device_id {
                return None;
            }
            let peer_id = PeerId::from_str(&peer.peer_id).ok()?;
            let transport = if mesh.is_peer_connected(&peer_id) {
                mesh.transfer_path(&peer_id)
            } else if mesh.can_attempt_relay() {
                "P2P_RELAY".to_owned()
            } else {
                return None;
            };
            Some((peer, peer_id, transport))
        })
        .collect::<Vec<_>>();
    peers.sort_by_key(|(_, _, transport)| match transport.as_str() {
        "LAN_DIRECT" => 0,
        "P2P_DIRECT" => 1,
        "P2P_RELAY" => 2,
        _ => 3,
    });

    for (peer, peer_id, transport) in peers.into_iter().take(8) {
        let authorization = client
            .post(format!(
                "{}/p2p/transfers/authorize",
                api_url.trim_end_matches('/')
            ))
            .bearer_auth(access_token)
            .json(&AuthorizePeerTransfer {
                source_device_id: &peer.device_id,
                node_id,
                version_id,
            })
            .send()
            .await
            .map_err(|_| "Could not authorize the P2P source device".to_owned())?;
        if !authorization.status().is_success() {
            eprintln!(
                "CloudFusion did not authorize P2P source {} ({})",
                peer.device_id,
                authorization.status()
            );
            continue;
        }
        let authorization = authorization
            .json::<ApiEnvelope<TransferAuthorization>>()
            .await
            .map_err(|_| "CloudFusion returned invalid P2P authorization".to_owned())?
            .data;
        let transfer = authorization.transfer;
        if Uuid::parse_str(&transfer.id).is_err()
            || transfer.source_device_id != peer.device_id
            || transfer.destination_device_id != destination_device_id
            || transfer.node_id != node_id
            || transfer.version_id != version_id
            || !transfer.content_hash.eq_ignore_ascii_case(expected_hash)
            || transfer.total_bytes.parse::<u64>().ok() != Some(expected_size)
            || transfer.status != "AUTHORIZED"
            || authorization.ticket.is_empty()
            || authorization.ticket.len() > 8192
        {
            cancel_peer_transfer(client, api_url, access_token, &transfer.id).await;
            eprintln!("CloudFusion returned mismatched P2P transfer metadata");
            continue;
        }

        let output = match tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .await
        {
            Ok(output) => output,
            Err(_) => {
                cancel_peer_transfer(client, api_url, access_token, &transfer.id).await;
                return Err("Could not safely create the temporary P2P sync file".to_owned());
            }
        };
        let result = receive_peer_file(
            client,
            api_url,
            access_token,
            mesh,
            &peer_id,
            &transport,
            &transfer,
            &authorization.ticket,
            expected_hash,
            expected_size,
            output,
        )
        .await;
        match result {
            Ok(()) => return Ok(true),
            Err(error) => {
                let _ = tokio::fs::remove_file(destination).await;
                cancel_peer_transfer(client, api_url, access_token, &transfer.id).await;
                eprintln!("P2P download from {} failed: {error}", peer.device_id);
            }
        }
    }
    Ok(false)
}

async fn receive_peer_file(
    client: &reqwest::Client,
    api_url: &str,
    access_token: &str,
    mesh: &MeshHandle,
    peer_id: &PeerId,
    transport: &str,
    transfer: &PeerTransferSession,
    ticket: &str,
    expected_hash: &str,
    expected_size: u64,
    mut output: tokio::fs::File,
) -> Result<(), String> {
    let mut hasher = Sha256::new();
    let mut offset = 0_u64;
    let mut first_request = true;
    let mut last_reported = 0_u64;
    let mut active_transport = transport.to_owned();
    loop {
        let request = ChunkRequest {
            transfer_id: transfer.id.clone(),
            ticket: first_request.then(|| ticket.to_owned()),
            content_hash: expected_hash.to_ascii_lowercase(),
            total_bytes: expected_size,
            offset,
            max_bytes: MAX_CHUNK_BYTES,
        };
        let response = mesh.request_chunk(peer_id.clone(), request).await?;
        if mesh.is_peer_connected(peer_id) {
            active_transport = mesh.transfer_path(peer_id);
        }
        first_request = false;
        let next_offset = validate_chunk_response(
            &response,
            &transfer.id,
            expected_hash,
            expected_size,
            offset,
        )?;
        output
            .write_all(&response.bytes)
            .await
            .map_err(|_| "Could not write a P2P sync block".to_owned())?;
        hasher.update(&response.bytes);
        offset = next_offset;
        if offset == expected_size
            || last_reported == 0
            || offset.saturating_sub(last_reported) >= 4 * 1024 * 1024
        {
            update_peer_transfer_state(
                client,
                api_url,
                access_token,
                &transfer.id,
                "TRANSFERRING",
                &active_transport,
                offset,
            )
            .await?;
            last_reported = offset;
        }
        if response.finished {
            break;
        }
    }
    output
        .flush()
        .await
        .map_err(|_| "Could not flush the P2P sync file".to_owned())?;
    output
        .sync_all()
        .await
        .map_err(|_| "Could not persist the P2P sync file".to_owned())?;
    drop(output);
    let actual_hash = crate::sync::hex(&hasher.finalize());
    if offset != expected_size || !actual_hash.eq_ignore_ascii_case(expected_hash) {
        return Err("P2P file failed its expected size or SHA-256 check".to_owned());
    }
    update_peer_transfer_state(
        client,
        api_url,
        access_token,
        &transfer.id,
        "VERIFYING",
        &active_transport,
        offset,
    )
    .await?;
    update_peer_transfer_state(
        client,
        api_url,
        access_token,
        &transfer.id,
        "COMPLETED",
        &active_transport,
        offset,
    )
    .await
}

fn validate_chunk_response(
    response: &ChunkResponse,
    transfer_id: &str,
    expected_hash: &str,
    expected_size: u64,
    expected_offset: u64,
) -> Result<u64, String> {
    if let Some(error) = response.error.as_deref() {
        return Err(format!("P2P source rejected the request: {error}"));
    }
    if response.transfer_id != transfer_id
        || response.offset != expected_offset
        || response.total_bytes != expected_size
        || !response.content_hash.eq_ignore_ascii_case(expected_hash)
        || response.bytes.len() > MAX_CHUNK_BYTES as usize
    {
        return Err("P2P source returned a block outside the authorized file".to_owned());
    }
    let next_offset = expected_offset
        .checked_add(response.bytes.len() as u64)
        .ok_or_else(|| "P2P byte count overflowed".to_owned())?;
    if next_offset > expected_size
        || (response.bytes.is_empty() && expected_offset < expected_size)
        || response.finished != (next_offset == expected_size)
    {
        return Err("P2P source returned an incomplete or oversized block".to_owned());
    }
    Ok(next_offset)
}

async fn update_peer_transfer_state(
    client: &reqwest::Client,
    api_url: &str,
    access_token: &str,
    transfer_id: &str,
    status: &str,
    transport: &str,
    bytes: u64,
) -> Result<(), String> {
    let response = client
        .post(format!(
            "{}/p2p/transfers/{transfer_id}/state",
            api_url.trim_end_matches('/')
        ))
        .bearer_auth(access_token)
        .json(&PeerTransferState {
            status,
            transport,
            bytes_transferred: bytes.to_string(),
        })
        .send()
        .await
        .map_err(|_| "Could not report P2P sync progress".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "CloudFusion rejected P2P sync progress ({})",
            response.status()
        ));
    }
    Ok(())
}

async fn cancel_peer_transfer(
    client: &reqwest::Client,
    api_url: &str,
    access_token: &str,
    transfer_id: &str,
) {
    if Uuid::parse_str(transfer_id).is_err() {
        return;
    }
    let _ = client
        .post(format!(
            "{}/p2p/transfers/{transfer_id}/cancel",
            api_url.trim_end_matches('/')
        ))
        .bearer_auth(access_token)
        .send()
        .await;
}

#[derive(Debug, Deserialize)]
struct TransferStateEnvelope {
    data: TransferState,
}

#[derive(Debug, Deserialize)]
struct TransferState {
    status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkRequest {
    transfer_id: String,
    ticket: Option<String>,
    content_hash: String,
    total_bytes: u64,
    offset: u64,
    max_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChunkResponse {
    transfer_id: String,
    content_hash: String,
    total_bytes: u64,
    offset: u64,
    bytes: Vec<u8>,
    finished: bool,
    error: Option<String>,
}

impl ChunkResponse {
    fn failure(request: &ChunkRequest, message: &str) -> Self {
        Self {
            transfer_id: request.transfer_id.clone(),
            content_hash: request.content_hash.clone(),
            total_bytes: request.total_bytes,
            offset: request.offset,
            bytes: Vec::new(),
            finished: false,
            error: Some(message.to_owned()),
        }
    }
}

struct SourceTransfer {
    peer_id: PeerId,
    file_path: std::path::PathBuf,
    content_hash: String,
    total_bytes: u64,
    bytes_served: u64,
    last_activity: Instant,
    last_api_check: Instant,
    modified_at: Option<SystemTime>,
}

#[derive(NetworkBehaviour)]
#[behaviour(to_swarm = "MeshEvent")]
struct MeshBehaviour {
    mdns: Toggle<mdns::tokio::Behaviour>,
    transfer: request_response::cbor::Behaviour<ChunkRequest, ChunkResponse>,
    relay_client: relay::client::Behaviour,
    identify: identify::Behaviour,
    dcutr: dcutr::Behaviour,
}

#[derive(Debug)]
enum MeshEvent {
    Mdns(mdns::Event),
    Transfer(request_response::Event<ChunkRequest, ChunkResponse>),
    RelayClient(relay::client::Event),
    Identify,
    Dcutr(dcutr::Event),
}

impl From<mdns::Event> for MeshEvent {
    fn from(event: mdns::Event) -> Self {
        Self::Mdns(event)
    }
}

impl From<request_response::Event<ChunkRequest, ChunkResponse>> for MeshEvent {
    fn from(event: request_response::Event<ChunkRequest, ChunkResponse>) -> Self {
        Self::Transfer(event)
    }
}

impl From<relay::client::Event> for MeshEvent {
    fn from(event: relay::client::Event) -> Self {
        Self::RelayClient(event)
    }
}

impl From<identify::Event> for MeshEvent {
    fn from(_: identify::Event) -> Self {
        Self::Identify
    }
}

impl From<dcutr::Event> for MeshEvent {
    fn from(event: dcutr::Event) -> Self {
        Self::Dcutr(event)
    }
}

pub(crate) async fn run_mesh(
    config: NodeConfig,
    mut credentials: watch::Receiver<MeshCredentials>,
    mut shutdown: watch::Receiver<bool>,
    handle: MeshHandle,
    mut commands: mpsc::Receiver<MeshCommand>,
) -> Result<(), String> {
    let private_key = STANDARD
        .decode(&config.peer_private_key)
        .map_err(|_| "Saved node identity is invalid".to_owned())?;
    let keypair = Keypair::from_protobuf_encoding(&private_key)
        .map_err(|_| "Saved node identity is invalid".to_owned())?;
    if keypair.public().to_peer_id().to_string() != config.peer_id {
        return Err("Saved node identity failed its integrity check".to_owned());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("cloudfusion-node/0.1.0")
        .build()
        .map_err(|_| "Could not initialize node mesh API client".to_owned())?;
    loop {
        if *shutdown.borrow() {
            break;
        }
        let auth = credentials.borrow().clone();
        if auth.access_token.is_empty() {
            tokio::select! {
                _ = shutdown.changed() => if *shutdown.borrow() { break; },
                _ = credentials.changed() => {},
            }
            continue;
        }
        let devices = match list_devices(&client, &auth).await {
            Ok(devices) => devices,
            Err(error) => {
                eprintln!("P2P settings check failed: {error}");
                wait_for_poll(&mut credentials, &mut shutdown).await?;
                continue;
            }
        };
        let device = devices
            .iter()
            .find(|device| config.device_id.as_deref() == Some(device.id.as_str()))
            .ok_or_else(|| "This node is no longer registered in CloudFusion".to_owned())?;
        if device.revoked_at.is_some() {
            return Err("This node has been revoked".to_owned());
        }
        if !can_join_mesh(device) {
            wait_for_poll(&mut credentials, &mut shutdown).await?;
            continue;
        }
        let trusted = devices
            .iter()
            .filter(|candidate| {
                candidate.id != device.id && candidate.p2p_enabled && candidate.revoked_at.is_none()
            })
            .filter_map(|candidate| candidate.peer_id.clone())
            .filter(|peer| PeerId::from_str(peer).is_ok())
            .collect::<HashSet<_>>();
        let initial_settings = device.clone();
        run_mesh_active(
            &client,
            &config,
            keypair.clone(),
            initial_settings,
            trusted,
            credentials.clone(),
            shutdown.clone(),
            handle.clone(),
            &mut commands,
        )
        .await?;
    }
    Ok(())
}

fn can_serve(device: &DeviceSettings) -> bool {
    can_join_mesh(device) && device.serve_local_files
}

fn can_join_mesh(device: &DeviceSettings) -> bool {
    device.p2p_enabled && (device.lan_discovery_enabled || device.internet_p2p_enabled)
}

async fn wait_for_poll(
    credentials: &mut watch::Receiver<MeshCredentials>,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    tokio::select! {
        _ = tokio::time::sleep(API_POLL_INTERVAL) => Ok(()),
        changed = credentials.changed() => changed.map_err(|_| "Node session channel closed".to_owned()),
        changed = shutdown.changed() => {
            if changed.is_err() || *shutdown.borrow() { Ok(()) } else { Ok(()) }
        }
    }
}

async fn list_devices(
    client: &reqwest::Client,
    auth: &MeshCredentials,
) -> Result<Vec<DeviceSettings>, String> {
    let response = client
        .get(format!("{}/devices", auth.api_url.trim_end_matches('/')))
        .bearer_auth(&auth.access_token)
        .send()
        .await
        .map_err(|_| "Could not reach CloudFusion device settings".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "CloudFusion device settings request failed ({})",
            response.status()
        ));
    }
    response
        .json::<ApiEnvelope<Vec<DeviceSettings>>>()
        .await
        .map(|value| value.data)
        .map_err(|_| "CloudFusion returned invalid device settings".to_owned())
}

async fn run_mesh_active(
    client: &reqwest::Client,
    config: &NodeConfig,
    keypair: Keypair,
    mut settings: DeviceSettings,
    mut trusted: HashSet<String>,
    mut credentials: watch::Receiver<MeshCredentials>,
    mut shutdown: watch::Receiver<bool>,
    handle: MeshHandle,
    commands: &mut mpsc::Receiver<MeshCommand>,
) -> Result<(), String> {
    let local_file_index = std::sync::Arc::new(std::sync::RwLock::new(HashMap::new()));
    let local_peer_id = keypair.public().to_peer_id();
    let relay_address = if settings.internet_p2p_enabled && settings.relay_allowed {
        configured_relay_address()?
    } else {
        None
    };
    handle.relay_configured.store(
        relay_address.is_some(),
        std::sync::atomic::Ordering::Release,
    );
    let relay_peer_id = relay_address.as_ref().and_then(relay_peer_id);
    let mdns = if settings.lan_discovery_enabled {
        Some(
            mdns::tokio::Behaviour::new(Default::default(), local_peer_id)
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let transfer = request_response::cbor::Behaviour::new(
        [(
            StreamProtocol::new(TRANSFER_PROTOCOL),
            ProtocolSupport::Full,
        )],
        request_response::Config::default(),
    );
    let mut swarm = SwarmBuilder::with_existing_identity(keypair.clone())
        .with_tokio()
        .with_quic()
        .with_relay_client(noise::Config::new, yamux::Config::default)
        .map_err(|error| error.to_string())?
        .with_behaviour(|key, relay_client| MeshBehaviour {
            mdns: Toggle::from(mdns),
            transfer,
            relay_client,
            identify: identify::Behaviour::new(identify::Config::new(
                "/cloudfusion/1.0.0".to_owned(),
                key.public(),
            )),
            dcutr: dcutr::Behaviour::new(key.public().to_peer_id()),
        })
        .map_err(|error| error.to_string())?
        .build();
    swarm
        .listen_on(
            "/ip4/0.0.0.0/udp/0/quic-v1"
                .parse()
                .map_err(|error: libp2p::multiaddr::Error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    if let Some(address) = &relay_address {
        let _ = swarm.dial(address.clone());
    }
    println!("P2P file sharing active for node {}", local_peer_id);

    let (availability_stop_tx, availability_stop_rx) = watch::channel(false);
    let availability_task = can_serve(&settings).then(|| {
        tokio::spawn(availability_worker(
            client.clone(),
            config.sync_roots.clone(),
            credentials.clone(),
            availability_stop_rx,
            local_file_index.clone(),
        ))
    });

    let mut poll = tokio::time::interval(API_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    poll.tick().await;
    let mut source_transfers: HashMap<String, SourceTransfer> = HashMap::new();
    let mut pending_requests = HashMap::new();
    let mut lan_peer_addresses: HashMap<PeerId, HashSet<Multiaddr>> = HashMap::new();
    let mut terminal_error = None;
    'mesh_loop: loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { break; }
            }
            changed = credentials.changed() => {
                if changed.is_err() { break; }
            }
            command = commands.recv() => {
                if let Some(command) = command {
                    if !trusted.contains(&command.peer_id.to_string()) {
                        let _ = command.response.send(Err("The source device is not trusted by CloudFusion".to_owned()));
                    } else {
                        if !handle.is_peer_connected(&command.peer_id) {
                            if let Some(address) = relay_address.as_ref().and_then(|relay| relay_peer_address(relay, &command.peer_id)) {
                                swarm.add_peer_address(command.peer_id.clone(), address);
                            }
                        }
                        let request_id = swarm.behaviour_mut().transfer.send_request(&command.peer_id, command.request);
                        pending_requests.insert(request_id, command.response);
                    }
                }
            }
            _ = poll.tick() => {
                let auth = credentials.borrow().clone();
                let devices = match list_devices(client, &auth).await {
                    Ok(devices) => devices,
                    Err(error) => { eprintln!("P2P settings refresh failed: {error}"); continue; }
                };
                let Some(current) = devices.iter().find(|item| item.id == settings.id) else { terminal_error = Some("This node is no longer registered in CloudFusion".to_owned()); break 'mesh_loop; };
                if current.revoked_at.is_some() { terminal_error = Some("This node has been revoked".to_owned()); break 'mesh_loop; }
                if !can_join_mesh(current) || current.serve_local_files != settings.serve_local_files || current.lan_discovery_enabled != settings.lan_discovery_enabled || current.internet_p2p_enabled != settings.internet_p2p_enabled || current.relay_allowed != settings.relay_allowed {
                    break 'mesh_loop;
                }
                settings = current.clone();
                trusted = devices.iter().filter(|candidate| candidate.id != settings.id && candidate.p2p_enabled && candidate.revoked_at.is_none()).filter_map(|candidate| candidate.peer_id.clone()).filter(|peer| PeerId::from_str(peer).is_ok()).collect();
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::Behaviour(MeshEvent::Mdns(mdns::Event::Discovered(peers))) => {
                    for (peer_id, address) in peers {
                        if peer_id == local_peer_id || !trusted.contains(&peer_id.to_string()) { continue; }
                        lan_peer_addresses.entry(peer_id.clone()).or_default().insert(address.clone());
                        let _ = swarm.dial(address.with(Protocol::P2p(peer_id)));
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::Mdns(mdns::Event::Expired(peers))) => {
                    for (peer_id, address) in peers {
                        if let Some(addresses) = lan_peer_addresses.get_mut(&peer_id) { addresses.remove(&address); if addresses.is_empty() { lan_peer_addresses.remove(&peer_id); } }
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::Transfer(request_response::Event::Message { peer, message, .. })) => match message {
                    Message::Request { request, channel, .. } => {
                        let auth = credentials.borrow().clone();
                        let response = serve_chunk_request(peer, request, local_peer_id, &trusted, &local_file_index, client, &auth, &mut source_transfers).await;
                        let _ = swarm.behaviour_mut().transfer.send_response(channel, response);
                    }
                    Message::Response { request_id, response } => {
                        if let Some(sender) = pending_requests.remove(&request_id) {
                            let _ = sender.send(Ok(response));
                        }
                    }
                },
                SwarmEvent::Behaviour(MeshEvent::Transfer(request_response::Event::OutboundFailure { request_id, error, .. })) => {
                    if let Some(sender) = pending_requests.remove(&request_id) {
                        let _ = sender.send(Err(format!("P2P request failed: {error}")));
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::RelayClient(event)) => { eprintln!("P2P relay event: {event:?}"); }
                SwarmEvent::Behaviour(MeshEvent::Dcutr(event)) => { eprintln!("P2P direct-upgrade event: {event:?}"); }
                SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                    if Some(peer_id) == relay_peer_id {
                        if let Some(address) = relay_address.as_ref() { let _ = swarm.listen_on(address.clone().with(Protocol::P2pCircuit)); }
                    } else if !trusted.contains(&peer_id.to_string()) {
                        let _ = swarm.disconnect_peer_id(peer_id);
                    } else {
                        let transport = if endpoint.is_relayed() {
                            eprintln!("P2P peer connected through relay");
                            "P2P_RELAY"
                        } else if lan_peer_addresses.contains_key(&peer_id) {
                            "LAN_DIRECT"
                        } else {
                            "P2P_DIRECT"
                        };
                        handle.record_peer_connection(&peer_id, transport);
                    }
                }
                SwarmEvent::ConnectionClosed { peer_id, num_established, .. } if num_established == 0 => {
                    handle.remove_peer_connection(&peer_id);
                }
                _ => {}
            }
        }
    }
    if let Ok(mut peers) = handle.connected_peers.write() {
        peers.clear();
    }
    if let Ok(mut paths) = handle.transfer_paths.write() {
        paths.clear();
    }
    handle
        .relay_configured
        .store(false, std::sync::atomic::Ordering::Release);
    for (_, sender) in pending_requests {
        let _ = sender.send(Err("The P2P mesh stopped before replying".to_owned()));
    }
    if let Some(task) = availability_task {
        let _ = availability_stop_tx.send(true);
        let _ = task.await;
    }
    terminal_error.map_or(Ok(()), Err)
}

async fn availability_worker(
    client: reqwest::Client,
    roots: Vec<sync::NodeSyncRoot>,
    mut credentials: watch::Receiver<MeshCredentials>,
    mut shutdown: watch::Receiver<bool>,
    index: std::sync::Arc<std::sync::RwLock<HashMap<(String, u64), std::path::PathBuf>>>,
) {
    let mut advertised = HashSet::new();
    let mut ticker = tokio::time::interval(AVAILABILITY_RENEW_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;
    loop {
        if *shutdown.borrow() {
            break;
        }
        match sync::verified_local_files(&roots).await {
            Ok(files) => {
                let mut next = HashMap::new();
                for file in &files {
                    next.entry((file.checksum.to_ascii_lowercase(), file.size))
                        .or_insert_with(|| file.path.clone());
                }
                if let Ok(mut current) = index.write() {
                    *current = next;
                }
                renew_availability(
                    &client,
                    &mut credentials,
                    &files,
                    &mut advertised,
                    &mut shutdown,
                )
                .await;
            }
            Err(error) => {
                eprintln!("Could not refresh verified local P2P files: {error}");
                if let Ok(mut current) = index.write() {
                    current.clear();
                }
            }
        }
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                _ = ticker.tick() => break,
                changed = credentials.changed() => if changed.is_err() { return; },
                changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return; },
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdvertiseRequest<'a> {
    node_id: &'a str,
    version_id: &'a str,
    content_hash: &'a str,
    size_bytes: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchAdvertiseRequest<'a> {
    items: Vec<AdvertiseRequest<'a>>,
}

async fn renew_availability(
    client: &reqwest::Client,
    credentials: &mut watch::Receiver<MeshCredentials>,
    files: &[sync::P2pLocalFile],
    advertised: &mut HashSet<(String, String)>,
    shutdown: &mut watch::Receiver<bool>,
) {
    let current = files
        .iter()
        .map(|file| (file.node_id.clone(), file.version_id.clone()))
        .collect::<HashSet<_>>();
    advertised.retain(|identity| current.contains(identity));
    for (batch_index, chunk) in files.chunks(500).enumerate() {
        if *shutdown.borrow() {
            return;
        }
        let body = BatchAdvertiseRequest {
            items: chunk
                .iter()
                .map(|file| AdvertiseRequest {
                    node_id: &file.node_id,
                    version_id: &file.version_id,
                    content_hash: &file.checksum,
                    size_bytes: file.size.to_string(),
                })
                .collect(),
        };
        let auth = credentials.borrow().clone();
        let response = client
            .post(format!(
                "{}/p2p/availability/batch",
                auth.api_url.trim_end_matches('/')
            ))
            .bearer_auth(&auth.access_token)
            .json(&body)
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                match response
                    .json::<ApiEnvelope<BatchAvailabilityReceipt>>()
                    .await
                {
                    Ok(receipt) => {
                        for result in receipt.data.results {
                            let identity = (result.node_id, result.version_id);
                            if result.advertised && current.contains(&identity) {
                                advertised.insert(identity);
                            }
                        }
                    }
                    Err(_) => eprintln!("CloudFusion returned an invalid P2P availability receipt"),
                }
            }
            Ok(response) if response.status().as_u16() == 429 => {
                eprintln!("P2P availability batch was rate limited; it will be retried next cycle");
            }
            Ok(response) => eprintln!(
                "CloudFusion rejected P2P availability batch (HTTP {})",
                response.status()
            ),
            Err(_) => eprintln!("Could not reach CloudFusion to renew P2P availability"),
        }
        if batch_index + 1 < files.chunks(500).len() {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(4_200)) => {},
                _ = credentials.changed() => {},
                changed = shutdown.changed() => if changed.is_err() || *shutdown.borrow() { return; },
            }
        }
    }
}

async fn serve_chunk_request(
    peer_id: PeerId,
    request: ChunkRequest,
    local_peer_id: PeerId,
    trusted_peer_ids: &HashSet<String>,
    local_file_index: &std::sync::Arc<
        std::sync::RwLock<HashMap<(String, u64), std::path::PathBuf>>,
    >,
    client: &reqwest::Client,
    auth: &MeshCredentials,
    transfers: &mut HashMap<String, SourceTransfer>,
) -> ChunkResponse {
    let fail = |reason: &str| ChunkResponse::failure(&request, reason);
    if !trusted_peer_ids.contains(&peer_id.to_string()) {
        return fail("Sender device is not trusted");
    }
    if Uuid::parse_str(&request.transfer_id).is_err()
        || request.content_hash.len() != 64
        || !request
            .content_hash
            .bytes()
            .all(|value| value.is_ascii_hexdigit())
        || request.max_bytes == 0
        || request.max_bytes > MAX_CHUNK_BYTES
        || request
            .ticket
            .as_ref()
            .is_some_and(|ticket| ticket.len() > 8192)
    {
        return fail("P2P chunk request is invalid");
    }
    transfers.retain(|_, transfer| transfer.last_activity.elapsed() < SOURCE_SESSION_TTL);
    if !transfers.contains_key(&request.transfer_id) {
        if request.offset > request.total_bytes || transfers.len() >= MAX_SOURCE_TRANSFERS {
            return fail("P2P transfer limit or resume offset is invalid");
        }
        let Some(ticket) = request.ticket.as_deref() else {
            return fail("P2P authorization ticket is missing");
        };
        let path = match local_file_index.read().ok().and_then(|files| {
            files
                .get(&(
                    request.content_hash.to_ascii_lowercase(),
                    request.total_bytes,
                ))
                .cloned()
        }) {
            Some(path) => path,
            None => return fail("No verified local copy matches this file version"),
        };
        let before =
            match verify_local_file(&path, &request.content_hash, request.total_bytes).await {
                Ok(modified) => modified,
                Err(_) => return fail("The local file changed after it was advertised"),
            };
        let receipt = match claim_ticket(client, auth, &request.transfer_id, ticket).await {
            Ok(value) => value,
            Err(_) => return fail("CloudFusion did not authorize this P2P transfer"),
        };
        if receipt.source_peer_id != local_peer_id.to_string()
            || receipt.destination_peer_id != peer_id.to_string()
            || !receipt
                .content_hash
                .eq_ignore_ascii_case(&request.content_hash)
            || receipt.total_bytes.parse::<u64>().ok() != Some(request.total_bytes)
        {
            return fail("The one-time ticket does not match this peer or file");
        }
        transfers.insert(
            request.transfer_id.clone(),
            SourceTransfer {
                peer_id,
                file_path: path,
                content_hash: request.content_hash.to_ascii_lowercase(),
                total_bytes: request.total_bytes,
                bytes_served: request.offset,
                last_activity: Instant::now(),
                last_api_check: Instant::now(),
                modified_at: before,
            },
        );
    }
    let Some(transfer) = transfers.get_mut(&request.transfer_id) else {
        return fail("P2P transfer session is unavailable");
    };
    if transfer.peer_id != peer_id
        || transfer.content_hash != request.content_hash.to_ascii_lowercase()
        || transfer.total_bytes != request.total_bytes
        || !valid_resume_offset(request.offset, transfer.bytes_served, transfer.total_bytes)
    {
        return fail("P2P request does not match its authorized transfer");
    }
    if transfer.last_api_check.elapsed() >= Duration::from_secs(5) {
        if !transfer_active(client, auth, &request.transfer_id).await {
            return fail("CloudFusion cancelled or expired this P2P transfer");
        }
        transfer.last_api_check = Instant::now();
    }
    let current_metadata = match std::fs::metadata(&transfer.file_path) {
        Ok(value) => value,
        Err(_) => return fail("The local source file is unavailable"),
    };
    if current_metadata.len() != transfer.total_bytes
        || current_metadata.modified().ok() != transfer.modified_at
    {
        return fail("The local source file changed during transfer");
    }
    transfer.last_activity = Instant::now();
    let length = request
        .max_bytes
        .min((transfer.total_bytes - request.offset).min(u32::MAX as u64) as u32)
        as usize;
    let path = transfer.file_path.clone();
    let offset = request.offset;
    let bytes = match tokio::task::spawn_blocking(move || read_chunk(&path, offset, length)).await {
        Ok(Ok(value)) => value,
        _ => return fail("Could not read the authorized file chunk"),
    };
    let next = request.offset.saturating_add(bytes.len() as u64);
    if bytes.is_empty() && request.total_bytes != 0 && next < request.total_bytes {
        return fail("The local source ended before its advertised size");
    }
    transfer.bytes_served = transfer.bytes_served.max(next);
    ChunkResponse {
        transfer_id: request.transfer_id,
        content_hash: transfer.content_hash.clone(),
        total_bytes: transfer.total_bytes,
        offset,
        finished: next == transfer.total_bytes,
        bytes,
        error: None,
    }
}

async fn verify_local_file(
    path: &std::path::Path,
    checksum: &str,
    size: u64,
) -> Result<Option<SystemTime>, String> {
    let file = path.to_path_buf();
    let expected = checksum.to_ascii_lowercase();
    tokio::task::spawn_blocking(move || {
        let before = std::fs::symlink_metadata(&file).map_err(|_| "local file missing")?;
        if before.file_type().is_symlink() || !before.is_file() || before.len() != size {
            return Err("local file unsafe".to_owned());
        }
        let modified = before.modified().ok();
        let mut input = File::open(&file).map_err(|_| "local file unreadable")?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 128 * 1024];
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|_| "local file read failed")?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        let after = std::fs::metadata(&file).map_err(|_| "local file vanished")?;
        let digest = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if after.len() != size || after.modified().ok() != modified || digest != expected {
            return Err("local file changed".to_owned());
        }
        Ok(modified)
    })
    .await
    .map_err(|_| "local file verification task failed".to_owned())?
}

async fn claim_ticket(
    client: &reqwest::Client,
    auth: &MeshCredentials,
    transfer_id: &str,
    ticket: &str,
) -> Result<ClaimReceipt, String> {
    let response = client
        .post(format!(
            "{}/p2p/transfers/{transfer_id}/claim",
            auth.api_url.trim_end_matches('/')
        ))
        .bearer_auth(&auth.access_token)
        .json(&serde_json::json!({"ticket": ticket}))
        .send()
        .await
        .map_err(|_| "ticket request failed".to_owned())?;
    if !response.status().is_success() {
        return Err("ticket rejected".to_owned());
    }
    response
        .json::<ApiEnvelope<ClaimReceipt>>()
        .await
        .map(|envelope| envelope.data)
        .map_err(|_| "invalid ticket response".to_owned())
}

async fn transfer_active(
    client: &reqwest::Client,
    auth: &MeshCredentials,
    transfer_id: &str,
) -> bool {
    let response = client
        .get(format!(
            "{}/p2p/transfers/{transfer_id}",
            auth.api_url.trim_end_matches('/')
        ))
        .bearer_auth(&auth.access_token)
        .send()
        .await;
    let Ok(response) = response else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    response
        .json::<TransferStateEnvelope>()
        .await
        .map(|value| matches!(value.data.status.as_str(), "CLAIMED" | "TRANSFERRING"))
        .unwrap_or(false)
}

fn read_chunk(path: &std::path::Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let mut file = File::open(path).map_err(|_| "Could not open local source".to_owned())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "Could not seek local source".to_owned())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|_| "Could not read local source chunk".to_owned())?;
    Ok(bytes)
}

fn configured_relay_address() -> Result<Option<Multiaddr>, String> {
    let Ok(value) = std::env::var("CLOUDFUSION_RELAY_MULTIADDR") else {
        return Ok(None);
    };
    let address = Multiaddr::from_str(value.trim())
        .map_err(|_| "CLOUDFUSION_RELAY_MULTIADDR is invalid".to_owned())?;
    if relay_peer_id(&address).is_none()
        || address
            .iter()
            .any(|protocol| matches!(protocol, Protocol::P2pCircuit))
    {
        return Err("Relay address must end in /p2p/<relay-peer-id>".to_owned());
    }
    Ok(Some(address))
}

fn relay_peer_id(address: &Multiaddr) -> Option<PeerId> {
    match address.iter().last()? {
        Protocol::P2p(peer_id) => Some(peer_id),
        _ => None,
    }
}

fn relay_peer_address(relay: &Multiaddr, peer_id: &PeerId) -> Option<Multiaddr> {
    relay_peer_id(relay)?;
    let mut address = relay.clone();
    address.push(Protocol::P2pCircuit);
    address.push(Protocol::P2p(peer_id.clone()));
    Some(address)
}

#[cfg(test)]
mod tests {
    use super::{
        can_join_mesh, can_serve, relay_peer_address, valid_resume_offset, validate_chunk_response,
        ChunkResponse, DeviceSettings, MAX_CHUNK_BYTES,
    };
    use libp2p::{Multiaddr, PeerId};
    use std::str::FromStr;

    #[test]
    fn sharing_requires_explicit_peer_and_file_serving_opt_in() {
        let mut device = DeviceSettings {
            id: "node".into(),
            peer_id: Some("peer".into()),
            p2p_enabled: true,
            lan_discovery_enabled: true,
            internet_p2p_enabled: false,
            relay_allowed: false,
            serve_local_files: true,
            revoked_at: None,
        };
        assert!(can_serve(&device));
        assert!(can_join_mesh(&device));
        device.serve_local_files = false;
        assert!(!can_serve(&device));
        assert!(can_join_mesh(&device));
        device.serve_local_files = true;
        device.p2p_enabled = false;
        assert!(!can_join_mesh(&device));
        assert!(!can_serve(&device));
    }

    #[test]
    fn resumable_peer_offsets_never_skip_unserved_bytes() {
        assert!(valid_resume_offset(5, 8, 10));
        assert!(!valid_resume_offset(9, 8, 10));
        assert!(!valid_resume_offset(11, 12, 10));
    }

    #[test]
    fn received_peer_chunks_must_match_the_authorized_version_and_offset() {
        let response = ChunkResponse {
            transfer_id: "transfer".to_owned(),
            content_hash: "ab".repeat(32),
            total_bytes: 5,
            offset: 0,
            bytes: vec![1, 2],
            finished: false,
            error: None,
        };
        assert_eq!(
            validate_chunk_response(&response, "transfer", &"ab".repeat(32), 5, 0),
            Ok(2)
        );
        assert!(validate_chunk_response(&response, "other", &"ab".repeat(32), 5, 0).is_err());
        assert!(validate_chunk_response(&response, "transfer", &"cd".repeat(32), 5, 0).is_err());
        assert!(validate_chunk_response(&response, "transfer", &"ab".repeat(32), 5, 1).is_err());

        let oversized = ChunkResponse {
            bytes: vec![0; MAX_CHUNK_BYTES as usize + 1],
            ..response
        };
        assert!(validate_chunk_response(&oversized, "transfer", &"ab".repeat(32), 5, 0).is_err());
    }

    #[test]
    fn relay_addresses_target_only_the_requested_peer() {
        let relay_id = PeerId::random();
        let target = PeerId::random();
        let relay = Multiaddr::from_str(&format!("/ip4/203.0.113.8/tcp/4001/p2p/{relay_id}"))
            .expect("relay address is valid");
        let address = relay_peer_address(&relay, &target).expect("relay route exists");
        assert!(address
            .to_string()
            .ends_with(&format!("/p2p-circuit/p2p/{target}")));
    }
}

fn valid_resume_offset(offset: u64, bytes_served: u64, total_bytes: u64) -> bool {
    offset <= bytes_served && offset <= total_bytes
}
