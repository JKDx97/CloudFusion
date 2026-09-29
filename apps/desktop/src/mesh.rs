use futures::StreamExt;
use libp2p::{
    identity::Keypair, mdns, multiaddr::Protocol, swarm::SwarmEvent, Multiaddr, PeerId,
    SwarmBuilder,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
    },
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;

#[derive(Default)]
pub struct MeshManager {
    running: Arc<AtomicBool>,
    trusted_peer_ids: Arc<RwLock<HashSet<String>>>,
    stop_signal: Mutex<Option<watch::Sender<bool>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshPeerUpdate {
    peer_id: String,
    status: String,
    multiaddr: Option<String>,
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
    let running = Arc::clone(&manager.running);
    let trusted_peer_ids = Arc::clone(&manager.trusted_peer_ids);

    tauri::async_runtime::spawn(async move {
        if let Err(error) = run_lan_mesh(app.clone(), keypair, trusted_peer_ids, stop_rx).await {
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
    Ok(())
}

async fn run_lan_mesh(
    app: AppHandle,
    keypair: Keypair,
    trusted_peer_ids: Arc<RwLock<HashSet<String>>>,
    mut stop_rx: watch::Receiver<bool>,
) -> Result<(), String> {
    let local_peer_id = keypair.public().to_peer_id();
    let mdns = mdns::tokio::Behaviour::new(Default::default(), local_peer_id)
        .map_err(|error| error.to_string())?;
    let mut swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_quic()
        .with_behaviour(|_| mdns)
        .map_err(|error| error.to_string())?
        .build();
    let listen_address: Multiaddr = "/ip4/0.0.0.0/udp/0/quic-v1"
        .parse()
        .map_err(|error: libp2p::multiaddr::Error| error.to_string())?;
    swarm
        .listen_on(listen_address)
        .map_err(|error| error.to_string())?;
    let _ = app.emit("mesh-status", "discovering");

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::Behaviour(mdns::Event::Discovered(peers)) => {
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
                SwarmEvent::Behaviour(mdns::Event::Expired(peers)) => {
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
    Ok(())
}

fn is_trusted(trusted_peer_ids: &RwLock<HashSet<String>>, peer_id: &PeerId) -> bool {
    trusted_peer_ids
        .read()
        .map(|trusted| trusted.contains(&peer_id.to_string()))
        .unwrap_or(false)
}
