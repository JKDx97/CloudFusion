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

    let mut swarm = build_relay_swarm(identity, allowed_peers)?;

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

fn build_relay_swarm(
    identity: identity::Keypair,
    allowed_peers: HashSet<PeerId>,
) -> Result<libp2p::Swarm<RelayBehaviour>, Box<dyn Error>> {
    let local_peer_id = identity.public().to_peer_id();
    let relay_behaviour = configured_relay_behaviour(local_peer_id, allowed_peers);

    Ok(SwarmBuilder::with_existing_identity(identity)
        .with_tokio()
        .with_tcp(
            tcp::Config::default(),
            libp2p::noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_behaviour(move |key| RelayBehaviour {
            relay: relay_behaviour,
            identify: identify::Behaviour::new(identify::Config::new(
                "/cloudfusion-relay/1.0.0".to_owned(),
                key.public(),
            )),
        })?
        .build())
}

fn configured_relay_behaviour(
    local_peer_id: PeerId,
    allowed_peers: HashSet<PeerId>,
) -> relay::Behaviour {
    let mut config = relay::Config::default();
    config.max_reservations = 128;
    config.max_reservations_per_peer = 2;
    config.reservation_duration = Duration::from_secs(60 * 60);
    config.max_circuits = 32;
    config.max_circuits_per_peer = 2;
    config.max_circuit_duration = MAX_CIRCUIT_DURATION;
    config.max_circuit_bytes = MAX_CIRCUIT_BYTES;

    let reservation_peers = allowed_peers.clone();
    config
        .reservation_rate_limiters
        .push(
            Box::new(move |peer: PeerId, _: &Multiaddr, _| reservation_peers.contains(&peer))
                as Box<dyn RateLimiter>,
        );
    config
        .circuit_src_rate_limiters
        .push(
            Box::new(move |peer: PeerId, _: &Multiaddr, _| allowed_peers.contains(&peer))
                as Box<dyn RateLimiter>,
        );

    let mut behaviour = relay::Behaviour::new(local_peer_id, config);
    behaviour.set_status(Some(relay::Status::Enable));
    behaviour
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
    use super::{build_relay_swarm, parse_allowed_peers, RelayBehaviourEvent};
    use futures::StreamExt;
    use libp2p::{
        core::multiaddr::Protocol,
        identity, noise, relay,
        request_response::{self, Message, ProtocolSupport},
        swarm::{NetworkBehaviour, StreamProtocol, SwarmEvent},
        tcp, yamux, Multiaddr, PeerId, SwarmBuilder,
    };
    use std::{collections::HashSet, time::Duration};

    #[derive(NetworkBehaviour)]
    #[behaviour(to_swarm = "TestClientEvent")]
    struct TestClientBehaviour {
        relay: relay::client::Behaviour,
        transfer: request_response::cbor::Behaviour<String, String>,
    }

    #[derive(Debug)]
    enum TestClientEvent {
        Relay,
        Transfer(request_response::Event<String, String>),
    }

    impl From<relay::client::Event> for TestClientEvent {
        fn from(_: relay::client::Event) -> Self {
            Self::Relay
        }
    }

    impl From<request_response::Event<String, String>> for TestClientEvent {
        fn from(event: request_response::Event<String, String>) -> Self {
            Self::Transfer(event)
        }
    }

    fn test_client() -> libp2p::Swarm<TestClientBehaviour> {
        let transfer = request_response::cbor::Behaviour::new(
            [(
                StreamProtocol::new("/cloudfusion/relay-integration-test/1"),
                ProtocolSupport::Full,
            )],
            request_response::Config::default(),
        );
        SwarmBuilder::with_new_identity()
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )
            .expect("client TCP transport builds")
            .with_quic()
            .with_relay_client(noise::Config::new, yamux::Config::default)
            .expect("relay client transport builds")
            .with_behaviour(|_, relay_client| TestClientBehaviour {
                relay: relay_client,
                transfer,
            })
            .expect("client behaviour builds")
            .build()
    }

    fn with_peer_id(base: &Multiaddr, peer_id: PeerId) -> Multiaddr {
        let mut address = base.clone();
        if !matches!(address.iter().last(), Some(Protocol::P2p(_))) {
            address.push(Protocol::P2p(peer_id));
        }
        address
    }

    fn relay_peer_address(base: &Multiaddr, relay_peer: PeerId, target: PeerId) -> Multiaddr {
        let mut address = with_peer_id(base, relay_peer);
        address.push(Protocol::P2pCircuit);
        address.push(Protocol::P2p(target));
        address
    }

    #[tokio::test]
    async fn allowlisted_clients_exchange_data_through_the_relay_circuit() {
        let relay_identity = identity::Keypair::generate_ed25519();
        let relay_peer_id = relay_identity.public().to_peer_id();
        let mut source = test_client();
        let mut destination = test_client();
        let source_peer_id = source.local_peer_id().to_owned();
        let destination_peer_id = destination.local_peer_id().to_owned();
        let allowed_peers = HashSet::from([source_peer_id, destination_peer_id]);
        let mut relay_swarm = build_relay_swarm(relay_identity, allowed_peers.clone())
            .expect("allowlisted relay swarm builds");
        relay_swarm
            .listen_on(
                "/ip4/127.0.0.1/tcp/0"
                    .parse()
                    .expect("relay address parses"),
            )
            .expect("relay listener starts");

        for address in ["/ip4/127.0.0.1/tcp/0", "/ip4/127.0.0.1/udp/0/quic-v1"] {
            source
                .listen_on(address.parse().expect("source address parses"))
                .expect("source listener starts");
            destination
                .listen_on(address.parse().expect("destination address parses"))
                .expect("destination listener starts");
        }

        let mut relay_address: Option<Multiaddr> = None;
        let mut source_relay_dial_started = false;
        let mut destination_relay_dial_started = false;
        let mut source_reservation_started = false;
        let mut destination_reservation_started = false;
        let mut source_reserved = false;
        let mut destination_reserved = false;
        let mut circuit_dial_started = false;
        let mut relayed_data_received = false;

        tokio::time::timeout(Duration::from_secs(20), async {
            while !relayed_data_received {
                #[derive(Debug)]
                enum Event {
                    Relay(SwarmEvent<RelayBehaviourEvent>),
                    Source(SwarmEvent<TestClientEvent>),
                    Destination(SwarmEvent<TestClientEvent>),
                }
                let event = tokio::select! {
                    event = relay_swarm.select_next_some() => Event::Relay(event),
                    event = source.select_next_some() => Event::Source(event),
                    event = destination.select_next_some() => Event::Destination(event),
                };
                match event {
                    Event::Relay(SwarmEvent::NewListenAddr { address, .. })
                        if address.iter().any(|part| matches!(part, Protocol::Tcp(_))) =>
                    {
                        let address = with_peer_id(&address, relay_peer_id);
                        relay_swarm.add_external_address(address.clone());
                        relay_address = Some(address);
                    }
                    Event::Source(SwarmEvent::ConnectionEstablished { peer_id, .. })
                        if peer_id == relay_peer_id && !source_reservation_started =>
                    {
                        let mut address = with_peer_id(
                            relay_address
                                .as_ref()
                                .expect("source only reserves after the relay starts listening"),
                            relay_peer_id,
                        );
                        address.push(Protocol::P2pCircuit);
                        source
                            .listen_on(address)
                            .expect("source requests an allowlisted reservation");
                        source_reservation_started = true;
                    }
                    Event::Destination(SwarmEvent::ConnectionEstablished { peer_id, .. })
                        if peer_id == relay_peer_id && !destination_reservation_started =>
                    {
                        let mut address = with_peer_id(
                            relay_address.as_ref().expect(
                                "destination only reserves after the relay starts listening",
                            ),
                            relay_peer_id,
                        );
                        address.push(Protocol::P2pCircuit);
                        destination
                            .listen_on(address)
                            .expect("destination requests an allowlisted reservation");
                        destination_reservation_started = true;
                    }
                    Event::Source(SwarmEvent::NewListenAddr { address, .. })
                        if address
                            .iter()
                            .any(|part| matches!(part, Protocol::P2pCircuit)) =>
                    {
                        source_reserved = true;
                    }
                    Event::Destination(SwarmEvent::NewListenAddr { address, .. })
                        if address
                            .iter()
                            .any(|part| matches!(part, Protocol::P2pCircuit)) =>
                    {
                        destination_reserved = true;
                    }
                    Event::Source(SwarmEvent::ConnectionEstablished {
                        peer_id, endpoint, ..
                    }) if peer_id == destination_peer_id => {
                        assert!(endpoint.is_relayed(), "the peer route must use the relay");
                        source.behaviour_mut().transfer.send_request(
                            &destination_peer_id,
                            "CloudFusion relay data".to_owned(),
                        );
                    }
                    Event::Destination(SwarmEvent::Behaviour(TestClientEvent::Transfer(
                        request_response::Event::Message {
                            message:
                                Message::Request {
                                    request, channel, ..
                                },
                            ..
                        },
                    ))) => {
                        assert_eq!(request, "CloudFusion relay data");
                        destination
                            .behaviour_mut()
                            .transfer
                            .send_response(channel, "relayed response".to_owned())
                            .expect("destination sends relay response");
                    }
                    Event::Source(SwarmEvent::Behaviour(TestClientEvent::Transfer(
                        request_response::Event::Message {
                            message: Message::Response { response, .. },
                            ..
                        },
                    ))) => {
                        assert_eq!(response, "relayed response");
                        relayed_data_received = true;
                    }
                    Event::Source(SwarmEvent::Behaviour(TestClientEvent::Transfer(
                        request_response::Event::OutboundFailure { error, .. },
                    ))) => panic!("relay transfer failed: {error}"),
                    Event::Source(SwarmEvent::Behaviour(TestClientEvent::Relay))
                    | Event::Destination(SwarmEvent::Behaviour(TestClientEvent::Relay)) => {}
                    _ => {}
                }

                if let Some(base_address) = relay_address.as_ref() {
                    if !source_relay_dial_started {
                        let address = with_peer_id(base_address, relay_peer_id);
                        source.dial(address).expect("source connects to relay");
                        source_relay_dial_started = true;
                    }
                    if !destination_relay_dial_started {
                        let address = with_peer_id(base_address, relay_peer_id);
                        destination
                            .dial(address)
                            .expect("destination connects to relay");
                        destination_relay_dial_started = true;
                    }
                }

                if !circuit_dial_started && source_reserved && destination_reserved {
                    let address = relay_peer_address(
                        relay_address.as_ref().expect("relay address exists"),
                        relay_peer_id,
                        destination_peer_id,
                    );
                    source
                        .dial(address)
                        .expect("source dials the destination through its reservation");
                    circuit_dial_started = true;
                }
            }
        })
        .await
        .expect("allowlisted relay data exchange completes before timeout");
    }

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
