use base64::{engine::general_purpose::STANDARD, Engine};
use keyring::Entry;
use libp2p::identity::Keypair;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

const KEYRING_SERVICE: &str = "com.cloudfusion.desktop";
const INSTALLATION_ID_KEY: &str = "installation-id";
const REFRESH_TOKEN_KEY: &str = "refresh-token";
const PEER_KEYPAIR_KEY: &str = "peer-keypair-ed25519";

#[derive(Clone)]
pub struct DeviceIdentity {
    installation_id: String,
    name: String,
    peer_keypair: Vec<u8>,
    peer_id: String,
    peer_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRegistration {
    installation_id: String,
    name: String,
    platform: &'static str,
    client_version: &'static str,
    peer_id: String,
    peer_public_key: String,
}

impl DeviceIdentity {
    pub fn load_or_create() -> Result<Self, Box<dyn std::error::Error>> {
        let entry = Entry::new(KEYRING_SERVICE, INSTALLATION_ID_KEY)?;
        let installation_id = match entry.get_password() {
            Ok(value) => {
                Uuid::parse_str(&value)?;
                value
            }
            Err(keyring::Error::NoEntry) => {
                let value = Uuid::new_v4().to_string();
                entry.set_password(&value)?;
                value
            }
            Err(error) => return Err(Box::new(error)),
        };

        let peer_entry = Entry::new(KEYRING_SERVICE, PEER_KEYPAIR_KEY)?;
        let peer_keypair = match peer_entry.get_secret() {
            Ok(secret) => {
                Keypair::from_protobuf_encoding(&secret)?;
                secret
            }
            Err(keyring::Error::NoEntry) => {
                let keypair = Keypair::generate_ed25519();
                let secret = keypair.to_protobuf_encoding()?;
                peer_entry.set_secret(&secret)?;
                secret
            }
            Err(error) => return Err(Box::new(error)),
        };
        let keypair = Keypair::from_protobuf_encoding(&peer_keypair)?;
        let peer_id = keypair.public().to_peer_id().to_string();
        let peer_public_key = STANDARD.encode(keypair.public().encode_protobuf());

        let name = std::env::var("COMPUTERNAME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("{} (CloudFusion)", value.trim()))
            .unwrap_or_else(|| "CloudFusion Desktop".to_owned());

        Ok(Self {
            installation_id,
            name,
            peer_keypair,
            peer_id,
            peer_public_key,
        })
    }

    pub fn peer_keypair(&self) -> Result<Keypair, String> {
        Keypair::from_protobuf_encoding(&self.peer_keypair).map_err(|error| error.to_string())
    }

    fn registration(&self) -> DeviceRegistration {
        DeviceRegistration {
            installation_id: self.installation_id.clone(),
            name: self.name.clone(),
            platform: if cfg!(target_os = "windows") {
                "WINDOWS"
            } else if cfg!(target_os = "macos") {
                "MACOS"
            } else {
                "LINUX"
            },
            client_version: env!("CARGO_PKG_VERSION"),
            peer_id: self.peer_id.clone(),
            peer_public_key: self.peer_public_key.clone(),
        }
    }
}

#[tauri::command]
pub fn get_device_registration(identity: State<'_, DeviceIdentity>) -> DeviceRegistration {
    identity.registration()
}

#[tauri::command]
pub fn get_refresh_token() -> Result<Option<String>, String> {
    let entry =
        Entry::new(KEYRING_SERVICE, REFRESH_TOKEN_KEY).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn store_refresh_token(refresh_token: String) -> Result<(), String> {
    if refresh_token.trim().is_empty() || refresh_token.len() > 8192 {
        return Err("The refresh token is invalid".to_owned());
    }
    Entry::new(KEYRING_SERVICE, REFRESH_TOKEN_KEY)
        .and_then(|entry| entry.set_password(&refresh_token))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn delete_refresh_token() -> Result<(), String> {
    let entry =
        Entry::new(KEYRING_SERVICE, REFRESH_TOKEN_KEY).map_err(|error| error.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::DeviceRegistration;

    #[test]
    fn device_registration_uses_the_api_platform_values() {
        let value = DeviceRegistration {
            installation_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            name: "Test Desktop".to_owned(),
            platform: "WINDOWS",
            client_version: "0.1.0",
            peer_id: "12D3KooWTestPeerIdentity".to_owned(),
            peer_public_key: "AQID".to_owned(),
        };

        let json = serde_json::to_value(value).expect("registration serializes");
        assert_eq!(json["platform"], "WINDOWS");
        assert_eq!(json["clientVersion"], "0.1.0");
        assert!(json.get("installationId").is_some());
    }
}
