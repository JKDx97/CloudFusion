use futures::StreamExt;
use libp2p::{
    dcutr, identify,
    identity::Keypair,
    mdns,
    multiaddr::Protocol,
    noise, relay,
    request_response::{self, Message, OutboundRequestId, ProtocolSupport},
    swarm::{
        behaviour::toggle::Toggle, ConnectionId, NetworkBehaviour, StreamProtocol, SwarmEvent,
    },
    yamux, Multiaddr, PeerId, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Seek, SeekFrom},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock, Weak,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, watch, Mutex as AsyncMutex, OwnedMutexGuard};

const TRANSFER_PROTOCOL: &str = "/cloudfusion/file-chunk/1";
pub(crate) const MAX_CHUNK_BYTES: u32 = 256 * 1024;
const MAX_SOURCE_TRANSFERS: usize = 4;
const SOURCE_SESSION_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct MeshApiCredentials {
    pub api_url: String,
    pub access_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChunkRequest {
    pub(crate) transfer_id: String,
    pub(crate) ticket: Option<String>,
    pub(crate) content_hash: String,
    pub(crate) total_bytes: u64,
    pub(crate) offset: u64,
    pub(crate) max_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChunkResponse {
    pub(crate) transfer_id: String,
    pub(crate) content_hash: String,
    pub(crate) total_bytes: u64,
    pub(crate) offset: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) finished: bool,
    pub(crate) error: Option<String>,
}

impl ChunkResponse {
    fn failure(request: &ChunkRequest, message: impl Into<String>) -> Self {
        Self {
            transfer_id: request.transfer_id.clone(),
            content_hash: request.content_hash.clone(),
            total_bytes: request.total_bytes,
            offset: request.offset,
            bytes: Vec::new(),
            finished: false,
            error: Some(message.into()),
        }
    }
}

struct MeshCommand {
    peer_id: PeerId,
    request: ChunkRequest,
    response: oneshot::Sender<Result<ChunkResponse, String>>,
}

struct SourceTransfer {
    peer_id: PeerId,
    file_path: std::path::PathBuf,
    content_hash: String,
    total_bytes: u64,
    bytes_served: u64,
    last_activity: Instant,
    last_api_check: Instant,
    modified_at: Option<std::time::SystemTime>,
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

#[derive(Default)]
pub struct MeshManager {
    running: Arc<AtomicBool>,
    trusted_peer_ids: Arc<RwLock<HashSet<String>>>,
    stop_signal: Mutex<Option<watch::Sender<bool>>>,
    local_file_index: Arc<RwLock<super::sync::LocalFileIndex>>,
    api_credentials: Arc<RwLock<Option<MeshApiCredentials>>>,
    command_sender: Arc<Mutex<Option<mpsc::Sender<MeshCommand>>>>,
    peer_transfer_paths: Arc<RwLock<HashMap<String, String>>>,
    partial_download_locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl MeshManager {
    pub fn new(local_file_index: Arc<RwLock<super::sync::LocalFileIndex>>) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            trusted_peer_ids: Arc::new(RwLock::new(HashSet::new())),
            stop_signal: Mutex::new(None),
            local_file_index,
            api_credentials: Arc::new(RwLock::new(None)),
            command_sender: Arc::new(Mutex::new(None)),
            peer_transfer_paths: Arc::new(RwLock::new(HashMap::new())),
            partial_download_locks: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) async fn lock_partial_download(
        &self,
        key: String,
    ) -> Result<OwnedMutexGuard<()>, String> {
        let lock = {
            let mut locks = self
                .partial_download_locks
                .lock()
                .map_err(|_| "The P2P partial-download lock is unavailable".to_owned())?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(AsyncMutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        Ok(lock.lock_owned().await)
    }

    pub(crate) async fn request_chunk(
        &self,
        peer_id: PeerId,
        request: ChunkRequest,
    ) -> Result<ChunkResponse, String> {
        let sender = self
            .command_sender
            .lock()
            .map_err(|_| "The local P2P channel is unavailable".to_owned())?
            .clone()
            .ok_or_else(|| "Activate the secure LAN connection first".to_owned())?;
        let (response_tx, response_rx) = oneshot::channel();
        sender
            .send(MeshCommand {
                peer_id,
                request,
                response: response_tx,
            })
            .await
            .map_err(|_| "The local P2P channel has stopped".to_owned())?;
        response_rx
            .await
            .map_err(|_| "The P2P peer did not return a response".to_owned())?
    }

    pub(crate) fn transfer_path_for_peer(&self, peer_id: &PeerId) -> String {
        self.peer_transfer_paths
            .read()
            .ok()
            .and_then(|paths| paths.get(&peer_id.to_string()).cloned())
            .unwrap_or_else(|| "P2P_DIRECT".to_owned())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshPeerUpdate {
    peer_id: String,
    status: String,
    multiaddr: Option<String>,
}

#[tauri::command]
pub fn configure_mesh_api(
    api_url: String,
    access_token: String,
    manager: State<'_, MeshManager>,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&api_url)
        .map_err(|_| "CloudFusion API address is invalid".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("CloudFusion API address must use HTTP or HTTPS".to_owned());
    }
    if access_token.trim().is_empty() || access_token.len() > 16_384 {
        return Err("The active CloudFusion session is unavailable".to_owned());
    }
    *manager
        .api_credentials
        .write()
        .map_err(|_| "The CloudFusion session is unavailable".to_owned())? =
        Some(MeshApiCredentials {
            api_url: api_url.trim_end_matches('/').to_owned(),
            access_token,
        });
    Ok(())
}

#[tauri::command]
pub fn set_trusted_mesh_peers(
    peer_ids: Vec<String>,
    manager: State<'_, MeshManager>,
) -> Result<(), String> {
    if peer_ids.len() > 256 {
        return Err("Too many trusted devices were provided".to_owned());
    }
    let mut trusted = HashSet::with_capacity(peer_ids.len());
    for peer_id in peer_ids {
        PeerId::from_str(&peer_id)
            .map_err(|_| "A device has an invalid peer identity".to_owned())?;
        trusted.insert(peer_id);
    }
    *manager
        .trusted_peer_ids
        .write()
        .map_err(|_| "The trusted-device list is unavailable".to_owned())? = trusted;
    Ok(())
}

#[tauri::command]
pub fn start_lan_mesh(
    app: AppHandle,
    manager: State<'_, MeshManager>,
    identity: State<'_, super::device::DeviceIdentity>,
    lan_discovery_enabled: bool,
    internet_p2p_enabled: bool,
    relay_allowed: bool,
) -> Result<(), String> {
    if !lan_discovery_enabled && !internet_p2p_enabled {
        return Err(
            "Enable LAN discovery or Internet P2P before starting the device mesh".to_owned(),
        );
    }
    let keypair = identity.peer_keypair()?;
    if manager
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(());
    }

    let (stop_tx, stop_rx) = watch::channel(false);
    *manager
        .stop_signal
        .lock()
        .map_err(|_| "The LAN mesh state is unavailable".to_owned())? = Some(stop_tx);
    let (command_tx, command_rx) = mpsc::channel(32);
    *manager
        .command_sender
        .lock()
        .map_err(|_| "The LAN mesh state is unavailable".to_owned())? = Some(command_tx);
    let running = Arc::clone(&manager.running);
    let trusted_peer_ids = Arc::clone(&manager.trusted_peer_ids);
    let local_file_index = Arc::clone(&manager.local_file_index);
    let api_credentials = Arc::clone(&manager.api_credentials);
    let command_sender = Arc::clone(&manager.command_sender);
    let peer_transfer_paths = Arc::clone(&manager.peer_transfer_paths);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_lan_mesh(
            app.clone(),
            keypair,
            trusted_peer_ids,
            local_file_index,
            api_credentials,
            command_sender,
            peer_transfer_paths,
            lan_discovery_enabled,
            internet_p2p_enabled,
            relay_allowed,
            command_rx,
            stop_rx,
        )
        .await
        {
            let _ = app.emit("mesh-status", format!("error:{error}"));
        }
        running.store(false, Ordering::Release);
        let _ = app.emit("mesh-status", "stopped");
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_lan_mesh(manager: State<'_, MeshManager>) -> Result<(), String> {
    if let Some(stop) = manager
        .stop_signal
        .lock()
        .map_err(|_| "The LAN mesh state is unavailable".to_owned())?
        .as_ref()
    {
        let _ = stop.send(true);
    }
    for _ in 0..100 {
        if !manager.running.load(Ordering::Acquire) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    if manager.running.load(Ordering::Acquire) {
        return Err("The device mesh did not stop in time".to_owned());
    }
    *manager
        .api_credentials
        .write()
        .map_err(|_| "The CloudFusion session is unavailable".to_owned())? = None;
    Ok(())
}

async fn run_lan_mesh(
    app: AppHandle,
    keypair: Keypair,
    trusted_peer_ids: Arc<RwLock<HashSet<String>>>,
    local_file_index: Arc<RwLock<super::sync::LocalFileIndex>>,
    api_credentials: Arc<RwLock<Option<MeshApiCredentials>>>,
    command_sender: Arc<Mutex<Option<mpsc::Sender<MeshCommand>>>>,
    peer_transfer_paths: Arc<RwLock<HashMap<String, String>>>,
    lan_discovery_enabled: bool,
    internet_p2p_enabled: bool,
    relay_allowed: bool,
    mut command_rx: mpsc::Receiver<MeshCommand>,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let local_peer_id = keypair.public().to_peer_id();
    let relay_address = if internet_p2p_enabled && relay_allowed {
        configured_relay_address()?
    } else {
        None
    };
    let relay_peer_id = relay_address.as_ref().and_then(relay_peer_id);
    let mdns = if lan_discovery_enabled {
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
    let listen_address: Multiaddr = "/ip4/0.0.0.0/udp/0/quic-v1"
        .parse()
        .map_err(|error: libp2p::multiaddr::Error| error.to_string())?;
    swarm
        .listen_on(listen_address)
        .map_err(|error| error.to_string())?;
    if let Some(address) = &relay_address {
        let _ = swarm.dial(address.clone());
        let _ = app.emit("mesh-status", "relay-connecting");
    } else {
        let status = if lan_discovery_enabled && internet_p2p_enabled {
            "discovering-lan;internet-p2p-needs-relay"
        } else if lan_discovery_enabled {
            "discovering-lan"
        } else if relay_allowed {
            "internet-p2p-needs-relay-address"
        } else {
            "internet-p2p-relay-disabled"
        };
        let _ = app.emit("mesh-status", status);
    }
    let local_peer_id = swarm.local_peer_id().to_owned();
    let mut pending_requests: HashMap<
        OutboundRequestId,
        oneshot::Sender<Result<ChunkResponse, String>>,
    > = HashMap::new();
    let mut source_transfers: HashMap<String, SourceTransfer> = HashMap::new();
    let mut lan_peer_addresses: HashMap<PeerId, HashSet<Multiaddr>> = HashMap::new();
    let mut peer_connections: HashMap<PeerId, HashMap<ConnectionId, String>> = HashMap::new();

    loop {
        tokio::select! {
            command = command_rx.recv() => {
                if let Some(command) = command {
                    if !is_trusted(&trusted_peer_ids, &command.peer_id) {
                        let _ = command.response.send(Err("This device is not trusted by CloudFusion".to_owned()));
                    } else {
                        if let Some(address) = relay_address.as_ref().and_then(|relay| relay_peer_address(relay, &command.peer_id)) {
                            swarm.add_peer_address(command.peer_id.clone(), address);
                        }
                        let request_id = swarm.behaviour_mut().transfer.send_request(&command.peer_id, command.request);
                        pending_requests.insert(request_id, command.response);
                    }
                }
            }
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::Behaviour(MeshEvent::Mdns(mdns::Event::Discovered(peers))) => {
                    for (peer_id, address) in peers {
                        if peer_id == local_peer_id || !is_trusted(&trusted_peer_ids, &peer_id) {
                            continue;
                        }
                        lan_peer_addresses.entry(peer_id.clone()).or_default().insert(address.clone());
                        let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                            peer_id: peer_id.to_string(),
                            status: "discovered".to_owned(),
                            multiaddr: Some(address.to_string()),
                        });
                        let address = address.with(Protocol::P2p(peer_id.clone()));
                        if let Err(error) = swarm.dial(address) {
                            let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                                peer_id: peer_id.to_string(),
                                status: format!("unreachable:{error}"),
                                multiaddr: None,
                            });
                        }
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::Mdns(mdns::Event::Expired(peers))) => {
                    for (peer_id, address) in peers {
                        if let Some(addresses) = lan_peer_addresses.get_mut(&peer_id) {
                            addresses.remove(&address);
                            if addresses.is_empty() {
                                lan_peer_addresses.remove(&peer_id);
                            }
                        }
                        if is_trusted(&trusted_peer_ids, &peer_id) {
                            let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                                peer_id: peer_id.to_string(),
                                status: "expired".to_owned(),
                                multiaddr: Some(address.to_string()),
                            });
                        }
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::Transfer(request_response::Event::Message { peer, message, .. })) => {
                    match message {
                        Message::Request { request, channel, .. } => {
                            let response = serve_chunk_request(
                                peer,
                                request,
                                local_peer_id,
                                &trusted_peer_ids,
                                &local_file_index,
                                &api_credentials,
                                &mut source_transfers,
                            ).await;
                            let _ = swarm.behaviour_mut().transfer.send_response(channel, response);
                        }
                        Message::Response { request_id, response } => {
                            if let Some(sender) = pending_requests.remove(&request_id) {
                                let _ = sender.send(Ok(response));
                            }
                        }
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::Transfer(request_response::Event::OutboundFailure { request_id, error, .. })) => {
                    if let Some(sender) = pending_requests.remove(&request_id) {
                        let _ = sender.send(Err(format!("P2P request failed: {error}")));
                    }
                }
                SwarmEvent::Behaviour(MeshEvent::Transfer(request_response::Event::InboundFailure { peer, error, .. })) => {
                    let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                        peer_id: peer.to_string(),
                        status: format!("transfer-error:{error}"),
                        multiaddr: None,
                    });
                }
                SwarmEvent::Behaviour(MeshEvent::RelayClient(event)) => {
                    let _ = app.emit("mesh-status", format!("relay:{event:?}"));
                }
                SwarmEvent::Behaviour(MeshEvent::Dcutr(event)) => {
                    let _ = app.emit("mesh-status", format!("internet-p2p:{event:?}"));
                }
                SwarmEvent::Behaviour(MeshEvent::Identify) => {}
                SwarmEvent::ConnectionEstablished { peer_id, connection_id, endpoint, .. } => {
                    if Some(peer_id) == relay_peer_id {
                        let _ = app.emit("mesh-status", "relay-connected");
                        if let Some(address) = relay_address.as_ref() {
                            let reservation = address.clone().with(Protocol::P2pCircuit);
                            if let Err(error) = swarm.listen_on(reservation) {
                                let _ = app.emit("mesh-status", format!("relay-reservation-error:{error}"));
                            } else {
                                let _ = app.emit("mesh-status", "relay-reserving");
                            }
                        }
                    } else if is_trusted(&trusted_peer_ids, &peer_id) {
                        let transport = if endpoint.is_relayed() {
                            "P2P_RELAY"
                        } else if lan_peer_addresses.contains_key(&peer_id) {
                            "LAN_DIRECT"
                        } else {
                            "P2P_DIRECT"
                        };
                        peer_connections.entry(peer_id.clone()).or_default().insert(connection_id, transport.to_owned());
                        update_peer_transfer_path(&peer_transfer_paths, &peer_connections, &peer_id);
                        let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                            peer_id: peer_id.to_string(),
                            status: format!("connected:{transport}"),
                            multiaddr: Some(endpoint.get_remote_address().to_string()),
                        });
                    } else {
                        let _ = swarm.disconnect_peer_id(peer_id);
                    }
                }
                SwarmEvent::ConnectionClosed { peer_id, connection_id, num_established, .. } => {
                    if Some(peer_id) == relay_peer_id {
                        let _ = app.emit("mesh-status", "relay-disconnected");
                    } else {
                        let known_connection = if let Some(connections) = peer_connections.get_mut(&peer_id) {
                            connections.remove(&connection_id);
                            true
                        } else {
                            false
                        };
                        if num_established == 0 {
                            peer_connections.remove(&peer_id);
                            if let Ok(mut paths) = peer_transfer_paths.write() {
                                paths.remove(&peer_id.to_string());
                            }
                            let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                                peer_id: peer_id.to_string(),
                                status: "disconnected".to_owned(),
                                multiaddr: None,
                            });
                        } else if known_connection {
                            update_peer_transfer_path(&peer_transfer_paths, &peer_connections, &peer_id);
                        }
                    }
                }
                SwarmEvent::NewListenAddr { address, .. } => {
                    if address.iter().any(|protocol| matches!(protocol, Protocol::P2pCircuit)) {
                        let _ = app.emit("mesh-status", format!("relay-reserved:{address}"));
                    }
                }
                _ => {}
            }
        }
    }
    if let Ok(mut sender) = command_sender.lock() {
        *sender = None;
    }
    if let Ok(mut paths) = peer_transfer_paths.write() {
        paths.clear();
    }
    for (_, sender) in pending_requests {
        let _ = sender.send(Err("The LAN P2P connection was stopped".to_owned()));
    }
    Ok(())
}

fn update_peer_transfer_path(
    shared_paths: &RwLock<HashMap<String, String>>,
    connections: &HashMap<PeerId, HashMap<ConnectionId, String>>,
    peer_id: &PeerId,
) {
    let path = connections
        .get(peer_id)
        .and_then(|paths| {
            paths
                .values()
                .min_by_key(|path| transfer_path_priority(path))
        })
        .cloned();
    if let Ok(mut shared) = shared_paths.write() {
        if let Some(path) = path {
            shared.insert(peer_id.to_string(), path);
        } else {
            shared.remove(&peer_id.to_string());
        }
    }
}

fn transfer_path_priority(path: &str) -> u8 {
    match path {
        "LAN_DIRECT" => 0,
        "P2P_DIRECT" => 1,
        "P2P_RELAY" => 2,
        _ => u8::MAX,
    }
}

fn configured_relay_address() -> Result<Option<Multiaddr>, String> {
    let Ok(value) = std::env::var("CLOUDFUSION_RELAY_MULTIADDR") else {
        return Ok(None);
    };
    parse_relay_address(&value).map(Some)
}

fn parse_relay_address(value: &str) -> Result<Multiaddr, String> {
    let address = Multiaddr::from_str(value.trim())
        .map_err(|_| "CLOUDFUSION_RELAY_MULTIADDR is not a valid multiaddress".to_owned())?;
    if relay_peer_id(&address).is_none()
        || address
            .iter()
            .any(|protocol| matches!(protocol, Protocol::P2pCircuit))
    {
        return Err(
            "The relay address must end with /p2p/<relay-peer-id> and not contain /p2p-circuit"
                .to_owned(),
        );
    }
    Ok(address)
}

fn relay_peer_id(address: &Multiaddr) -> Option<PeerId> {
    match address.iter().last()? {
        Protocol::P2p(peer_id) => Some(peer_id),
        _ => None,
    }
}

fn relay_peer_address(relay_address: &Multiaddr, peer_id: &PeerId) -> Option<Multiaddr> {
    Some(
        relay_address
            .clone()
            .with(Protocol::P2pCircuit)
            .with(Protocol::P2p(peer_id.clone())),
    )
}

async fn serve_chunk_request(
    peer_id: PeerId,
    request: ChunkRequest,
    local_peer_id: PeerId,
    trusted_peer_ids: &RwLock<HashSet<String>>,
    local_file_index: &RwLock<super::sync::LocalFileIndex>,
    api_credentials: &RwLock<Option<MeshApiCredentials>>,
    transfers: &mut HashMap<String, SourceTransfer>,
) -> ChunkResponse {
    let fail = |message: &str| ChunkResponse::failure(&request, message);
    if !is_trusted(trusted_peer_ids, &peer_id) {
        return fail("Sender device is not trusted");
    }
    if uuid::Uuid::parse_str(&request.transfer_id).is_err()
        || request.content_hash.len() != 64
        || !request
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.max_bytes == 0
        || request.max_bytes > MAX_CHUNK_BYTES
    {
        return fail("P2P chunk request is invalid");
    }
    transfers.retain(|_, transfer| transfer.last_activity.elapsed() < SOURCE_SESSION_TTL);

    if !transfers.contains_key(&request.transfer_id) {
        if request.offset > request.total_bytes {
            return fail("P2P resume offset exceeds the authorized file size");
        }
        if transfers.len() >= MAX_SOURCE_TRANSFERS {
            return fail("This device has reached its active P2P transfer limit");
        }
        let Some(ticket) = request.ticket.as_deref() else {
            return fail("P2P authorization ticket is missing");
        };
        let Ok(file_path) = super::sync::resolve_indexed_file(
            local_file_index,
            &request.content_hash,
            request.total_bytes,
        ) else {
            return fail("No indexed local copy matches the authorized file version");
        };
        let path_for_hash = file_path.clone();
        let expected_hash = request.content_hash.to_ascii_lowercase();
        let hash_result = tokio::task::spawn_blocking(move || {
            let before = std::fs::metadata(&path_for_hash).map_err(|error| error.to_string())?;
            let before_modified = before.modified().ok();
            let before_size = before.len();
            let actual_hash = super::sync::hash_file(&path_for_hash)?;
            let after = std::fs::metadata(&path_for_hash).map_err(|error| error.to_string())?;
            if before_size != after.len() || before_modified != after.modified().ok() {
                return Err("Local file changed during verification".to_owned());
            }
            Ok((actual_hash, before_modified))
        })
        .await;
        let modified_at = match hash_result {
            Ok(Ok((actual_hash, modified_at)))
                if actual_hash.eq_ignore_ascii_case(&expected_hash) =>
            {
                modified_at
            }
            _ => {
                return fail(
                    "The local file changed after it was indexed; analyze the folders again",
                )
            }
        };
        let credentials = match api_credentials.read().ok().and_then(|value| value.clone()) {
            Some(value) => value,
            None => return fail("The CloudFusion session is unavailable on the source device"),
        };
        let claim =
            super::transfer::claim_source_transfer(&credentials, &request.transfer_id, ticket)
                .await;
        let claim = match claim {
            Ok(claim) => claim,
            Err(_) => return fail("CloudFusion did not authorize this P2P transfer"),
        };
        if claim.source_peer_id != local_peer_id.to_string()
            || claim.destination_peer_id != peer_id.to_string()
            || !claim
                .content_hash
                .eq_ignore_ascii_case(&request.content_hash)
            || claim.total_bytes.parse::<u64>().ok() != Some(request.total_bytes)
        {
            return fail("The P2P ticket does not match this peer or file version");
        }
        transfers.insert(
            request.transfer_id.clone(),
            SourceTransfer {
                peer_id,
                file_path,
                content_hash: request.content_hash.to_ascii_lowercase(),
                total_bytes: request.total_bytes,
                bytes_served: request.offset,
                last_activity: Instant::now(),
                last_api_check: Instant::now(),
                modified_at,
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
        let credentials = match api_credentials.read().ok().and_then(|value| value.clone()) {
            Some(value) => value,
            None => return fail("The CloudFusion session is unavailable on the source device"),
        };
        if super::transfer::ensure_source_transfer_active(&credentials, &request.transfer_id)
            .await
            .is_err()
        {
            return fail("CloudFusion cancelled or expired this P2P transfer");
        }
        transfer.last_api_check = Instant::now();
    }
    let current_metadata = match std::fs::metadata(&transfer.file_path) {
        Ok(metadata) => metadata,
        Err(_) => return fail("The local source file is no longer available"),
    };
    if current_metadata.len() != transfer.total_bytes
        || current_metadata.modified().ok() != transfer.modified_at
    {
        return fail("The local source file changed during transfer");
    }
    transfer.last_activity = Instant::now();
    let chunk_length = request
        .max_bytes
        .min((transfer.total_bytes - request.offset).min(u32::MAX as u64) as u32)
        as usize;
    let path = transfer.file_path.clone();
    let offset = request.offset;
    let bytes =
        match tokio::task::spawn_blocking(move || read_chunk(&path, offset, chunk_length)).await {
            Ok(Ok(bytes)) => bytes,
            _ => return fail("Could not read the authorized local file chunk"),
        };
    let next_offset = request.offset.saturating_add(bytes.len() as u64);
    if bytes.is_empty() && request.total_bytes != 0 && next_offset < request.total_bytes {
        return fail("The local file ended before its authorized size");
    }
    transfer.bytes_served = transfer.bytes_served.max(next_offset);
    ChunkResponse {
        transfer_id: request.transfer_id,
        content_hash: transfer.content_hash.clone(),
        total_bytes: transfer.total_bytes,
        offset: offset,
        finished: next_offset == transfer.total_bytes,
        bytes,
        error: None,
    }
}

fn read_chunk(path: &std::path::Path, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn valid_resume_offset(offset: u64, bytes_served: u64, total_bytes: u64) -> bool {
    offset <= bytes_served && offset <= total_bytes
}

fn is_trusted(trusted_peer_ids: &RwLock<HashSet<String>>, peer_id: &PeerId) -> bool {
    trusted_peer_ids
        .read()
        .map(|trusted| trusted.contains(&peer_id.to_string()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_relay_address, relay_peer_address, relay_peer_id, transfer_path_priority,
        valid_resume_offset,
    };
    use libp2p::{multiaddr::Protocol, Multiaddr, PeerId};
    use std::str::FromStr;

    #[test]
    fn relay_address_requires_a_trailing_relay_identity() {
        let relay_id = PeerId::random();
        let address = format!("/ip4/203.0.113.10/tcp/4001/p2p/{relay_id}");
        let parsed = parse_relay_address(&address).expect("valid relay address");
        assert_eq!(relay_peer_id(&parsed), Some(relay_id));

        assert!(parse_relay_address("/ip4/203.0.113.10/tcp/4001").is_err());
        assert!(parse_relay_address(&format!("{address}/p2p-circuit")).is_err());
    }

    #[test]
    fn peer_route_uses_the_relay_circuit_protocol() {
        let relay_id = PeerId::random();
        let peer_id = PeerId::random();
        let address = Multiaddr::from_str(&format!("/ip4/203.0.113.10/tcp/4001/p2p/{relay_id}"))
            .expect("valid relay address");
        let route = relay_peer_address(&address, &peer_id).expect("relay peer route");
        assert!(route
            .iter()
            .any(|part| matches!(part, Protocol::P2pCircuit)));
        assert!(matches!(route.iter().last(), Some(Protocol::P2p(id)) if id == peer_id));
    }

    #[test]
    fn preferred_transfer_path_prioritizes_local_direct_then_internet_direct_then_relay() {
        assert!(transfer_path_priority("LAN_DIRECT") < transfer_path_priority("P2P_DIRECT"));
        assert!(transfer_path_priority("P2P_DIRECT") < transfer_path_priority("P2P_RELAY"));
    }

    #[test]
    fn resumed_peer_requests_allow_replays_but_not_unserved_gaps() {
        assert!(valid_resume_offset(780, 780, 1000));
        assert!(valid_resume_offset(700, 780, 1000));
        assert!(valid_resume_offset(1000, 1000, 1000));
        assert!(!valid_resume_offset(781, 780, 1000));
        assert!(!valid_resume_offset(1001, 1000, 1000));
    }
}
