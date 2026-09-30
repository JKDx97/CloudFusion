use futures::StreamExt;
use libp2p::{
    identity::Keypair,
    mdns,
    multiaddr::Protocol,
    request_response::{self, Message, OutboundRequestId, ProtocolSupport},
    swarm::{NetworkBehaviour, StreamProtocol, SwarmEvent},
    Multiaddr, PeerId, SwarmBuilder,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Seek, SeekFrom},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, watch};

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
    completed: bool,
    last_activity: Instant,
    last_api_check: Instant,
    modified_at: Option<std::time::SystemTime>,
}

#[derive(NetworkBehaviour)]
#[behaviour(to_swarm = "MeshEvent")]
struct MeshBehaviour {
    mdns: mdns::tokio::Behaviour,
    transfer: request_response::cbor::Behaviour<ChunkRequest, ChunkResponse>,
}

#[derive(Debug)]
enum MeshEvent {
    Mdns(mdns::Event),
    Transfer(request_response::Event<ChunkRequest, ChunkResponse>),
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

#[derive(Default)]
pub struct MeshManager {
    running: Arc<AtomicBool>,
    trusted_peer_ids: Arc<RwLock<HashSet<String>>>,
    stop_signal: Mutex<Option<watch::Sender<bool>>>,
    local_file_index: Arc<RwLock<super::sync::LocalFileIndex>>,
    api_credentials: Arc<RwLock<Option<MeshApiCredentials>>>,
    command_sender: Arc<Mutex<Option<mpsc::Sender<MeshCommand>>>>,
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
        }
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
) -> Result<(), String> {
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

    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_lan_mesh(
            app.clone(),
            keypair,
            trusted_peer_ids,
            local_file_index,
            api_credentials,
            command_sender,
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
pub fn stop_lan_mesh(manager: State<'_, MeshManager>) -> Result<(), String> {
    if let Some(stop) = manager
        .stop_signal
        .lock()
        .map_err(|_| "The LAN mesh state is unavailable".to_owned())?
        .as_ref()
    {
        let _ = stop.send(true);
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
    mut command_rx: mpsc::Receiver<MeshCommand>,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let local_peer_id = keypair.public().to_peer_id();
    let mdns = mdns::tokio::Behaviour::new(Default::default(), local_peer_id)
        .map_err(|error| error.to_string())?;
    let transfer = request_response::cbor::Behaviour::new(
        [(
            StreamProtocol::new(TRANSFER_PROTOCOL),
            ProtocolSupport::Full,
        )],
        request_response::Config::default(),
    );
    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_quic()
        .with_behaviour(|_| MeshBehaviour { mdns, transfer })
        .map_err(|error| error.to_string())?
        .build();
    let listen_address: Multiaddr = "/ip4/0.0.0.0/udp/0/quic-v1"
        .parse()
        .map_err(|error: libp2p::multiaddr::Error| error.to_string())?;
    swarm
        .listen_on(listen_address)
        .map_err(|error| error.to_string())?;
    let _ = app.emit("mesh-status", "discovering");
    let local_peer_id = swarm.local_peer_id().to_owned();
    let mut pending_requests: HashMap<
        OutboundRequestId,
        oneshot::Sender<Result<ChunkResponse, String>>,
    > = HashMap::new();
    let mut source_transfers: HashMap<String, SourceTransfer> = HashMap::new();

    loop {
        tokio::select! {
            command = command_rx.recv() => {
                if let Some(command) = command {
                    if !is_trusted(&trusted_peer_ids, &command.peer_id) {
                        let _ = command.response.send(Err("This device is not trusted by CloudFusion".to_owned()));
                    } else {
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
                SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                    if is_trusted(&trusted_peer_ids, &peer_id) {
                        let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                            peer_id: peer_id.to_string(),
                            status: "connected".to_owned(),
                            multiaddr: None,
                        });
                    } else {
                        let _ = swarm.disconnect_peer_id(peer_id);
                    }
                }
                SwarmEvent::ConnectionClosed { peer_id, .. } => {
                    let _ = app.emit("mesh-peer-update", MeshPeerUpdate {
                        peer_id: peer_id.to_string(),
                        status: "disconnected".to_owned(),
                        multiaddr: None,
                    });
                }
                _ => {}
            }
        }
    }
    if let Ok(mut sender) = command_sender.lock() {
        *sender = None;
    }
    for (_, sender) in pending_requests {
        let _ = sender.send(Err("The LAN P2P connection was stopped".to_owned()));
    }
    Ok(())
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
        if request.offset != 0 {
            return fail("A P2P transfer must start at byte zero");
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
                bytes_served: 0,
                completed: false,
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
        || request.offset > transfer.total_bytes
        || request.offset != transfer.bytes_served
        || transfer.completed
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
    transfer.bytes_served = next_offset;
    transfer.completed = next_offset == transfer.total_bytes;
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

fn is_trusted(trusted_peer_ids: &RwLock<HashSet<String>>, peer_id: &PeerId) -> bool {
    trusted_peer_ids
        .read()
        .map(|trusted| trusted.contains(&peer_id.to_string()))
        .unwrap_or(false)
}
