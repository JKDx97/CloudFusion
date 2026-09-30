use std::{
    collections::HashSet,
    env,
    error::Error,
    fs::{self, OpenOptions},
    io::Write,
    net::IpAddr,
    path::PathBuf,
    str::FromStr,
    time::Duration,
};

use futures::StreamExt;
use libp2p::{
    core::{multiaddr::Protocol, Multiaddr},
    identify, identity,
    relay::{self, RateLimiter},
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux, PeerId, SwarmBuilder,
};

const DEFAULT_PORT: u16 = 4001;
const MAX_ALLOWED_PEERS: usize = 512;
const MAX_CIRCUIT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CIRCUIT_DURATION: Duration = Duration::from_secs(15 * 60);

#[derive(NetworkBehaviour)]
struct RelayBehaviour {
    relay: relay::Behaviour,
    identify: identify::Behaviour,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let allowed_peers = read_allowed_peers()?;
    let allowed_peer_count = allowed_peers.len();
    let identity = load_or_create_identity()?;
    let local_peer_id = identity.public().to_peer_id();
    let port = env::var("CLOUDFUSION_RELAY_PORT")
        .ok()
        .map(|value| value.parse::<u16>())
        .transpose()?
        .unwrap_or(DEFAULT_PORT);
    let bind_ip = env::var("CLOUDFUSION_RELAY_BIND_IP")
        .unwrap_or_else(|_| "0.0.0.0".to_owned())
        .parse::<IpAddr>()?;

    let mut relay_config = relay::Config::default();
    relay_config.max_reservations = 128;
    relay_config.max_reservations_per_peer = 2;
    relay_config.reservation_duration = Duration::from_secs(60 * 60);
    relay_config.max_circuits = 32;
    relay_config.max_circuits_per_peer = 2;
    relay_config.max_circuit_duration = MAX_CIRCUIT_DURATION;
    relay_config.max_circuit_bytes = MAX_CIRCUIT_BYTES;

    let reservation_peers = allowed_peers.clone();
    relay_config
        .reservation_rate_limiters
        .push(
            Box::new(move |peer: PeerId, _: &Multiaddr, _| reservation_peers.contains(&peer))
                as Box<dyn RateLimiter>,
        );
    let circuit_peers = allowed_peers;
    relay_config
        .circuit_src_rate_limiters
        .push(
            Box::new(move |peer: PeerId, _: &Multiaddr, _| circuit_peers.contains(&peer))
                as Box<dyn RateLimiter>,
        );

    let mut relay_behaviour = relay::Behaviour::new(local_peer_id, relay_config);
    relay_behaviour.set_status(Some(relay::Status::Enable));
    let mut swarm = SwarmBuilder::with_existing_identity(identity)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            libp2p::noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_behaviour(|key| RelayBehaviour {
            relay: relay_behaviour,
            identify: identify::Behaviour::new(identify::Config::new(
                "/cloudfusion-relay/1.0.0".to_owned(),
                key.public(),
            )),
        })?
        .build();

    let listen_ip = match bind_ip {
        IpAddr::V4(ip) => Protocol::Ip4(ip),
        IpAddr::V6(ip) => Protocol::Ip6(ip),
    };
    swarm.listen_on(Multiaddr::empty().with(listen_ip).with(Protocol::Tcp(port)))?;

    let listen_ip = match bind_ip {
        IpAddr::V4(ip) => Protocol::Ip4(ip),
        IpAddr::V6(ip) => Protocol::Ip6(ip),
    };
    swarm.listen_on(
        Multiaddr::empty()
            .with(listen_ip)
            .with(Protocol::Udp(port))
            .with(Protocol::QuicV1),
    )?;

    if let Ok(value) = env::var("CLOUDFUSION_RELAY_EXTERNAL_IP") {
        let external_ip = value.parse::<IpAddr>()?;
        let external_protocol = match external_ip {
            IpAddr::V4(ip) => Protocol::Ip4(ip),
            IpAddr::V6(ip) => Protocol::Ip6(ip),
        };
        swarm.add_external_address(
            Multiaddr::empty()
                .with(external_protocol)
                .with(Protocol::Tcp(port)),
        );
    }

    println!("CloudFusion Relay v2 peer: {local_peer_id}");
    println!("Allowed CloudFusion devices: {allowed_peer_count}");
    println!("Relay resource limits: 32 circuits, 2 per device, 64 MiB and 15 min per circuit");

    loop {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => println!("Listening on {address}"),
                SwarmEvent::Behaviour(RelayBehaviourEvent::Identify(identify::Event::Received { info, .. })) => {
                    swarm.add_external_address(info.observed_addr);
                }
                SwarmEvent::Behaviour(RelayBehaviourEvent::Relay(event)) => println!("Relay event: {event:?}"),
                SwarmEvent::ConnectionEstablished { peer_id, .. } => println!("Peer connected: {peer_id}"),
                SwarmEvent::ConnectionClosed { peer_id, .. } => println!("Peer disconnected: {peer_id}"),
                _ => {}
            }
        }
    }

    Ok(())
}

fn read_allowed_peers() -> Result<HashSet<PeerId>, Box<dyn Error>> {
    let raw = env::var("CLOUDFUSION_RELAY_ALLOWED_PEERS")?;
    parse_allowed_peers(&raw)
}

fn parse_allowed_peers(raw: &str) -> Result<HashSet<PeerId>, Box<dyn Error>> {
    let peers = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PeerId::from_str)
        .collect::<Result<HashSet<_>, _>>()?;
    if peers.is_empty() || peers.len() > MAX_ALLOWED_PEERS {
        return Err(format!(
            "Configure between 1 and {MAX_ALLOWED_PEERS} device IDs in CLOUDFUSION_RELAY_ALLOWED_PEERS"
        )
        .into());
    }
    Ok(peers)
}

fn load_or_create_identity() -> Result<identity::Keypair, Box<dyn Error>> {
    let path = env::var_os("CLOUDFUSION_RELAY_KEY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("relay-key.pb"));
    if path.exists() {
        return Ok(identity::Keypair::from_protobuf_encoding(&fs::read(path)?)?);
    }

    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let keypair = identity::Keypair::generate_ed25519();
    let encoded = keypair.to_protobuf_encoding()?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&path) {
        Ok(mut file) => file.write_all(&encoded)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Ok(identity::Keypair::from_protobuf_encoding(&fs::read(path)?)?);
        }
        Err(error) => return Err(error.into()),
    }
    Ok(keypair)
}

#[cfg(test)]
mod tests {
    use super::parse_allowed_peers;
    use libp2p::PeerId;

    #[test]
    fn relay_allowlist_parses_and_deduplicates_device_ids() {
        let first = PeerId::random();
        let second = PeerId::random();
        let peers = parse_allowed_peers(&format!(" {first}, {second}, {first} "))
            .expect("valid non-empty allowlist");
        assert_eq!(peers.len(), 2);
        assert!(parse_allowed_peers("").is_err());
        assert!(parse_allowed_peers("not-a-peer-id").is_err());
    }
}
