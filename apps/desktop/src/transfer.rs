use crate::mesh::{ChunkRequest, MeshApiCredentials, MeshManager, MAX_CHUNK_BYTES};
use libp2p::PeerId;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    str::FromStr,
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[tauri::command]
pub async fn choose_p2p_destination(file_name: String) -> Result<Option<String>, String> {
    if file_name.trim().is_empty()
        || file_name.len() > 255
        || Path::new(&file_name)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(file_name.as_str())
    {
        return Err("CloudFusion file name is invalid".to_owned());
    }
    tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_file_name(file_name)
            .save_file()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "Could not open the save dialog".to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimedTransfer {
    pub(crate) source_peer_id: String,
    pub(crate) destination_peer_id: String,
    pub(crate) content_hash: String,
    pub(crate) total_bytes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferSession {
    source_device_id: String,
    destination_device_id: String,
    node_id: String,
    version_id: String,
    content_hash: String,
    total_bytes: String,
    status: String,
}

#[tauri::command]
pub async fn download_p2p_file(
    app: AppHandle,
    manager: State<'_, MeshManager>,
    api_url: String,
    access_token: String,
    transfer_id: String,
    ticket: String,
    source_peer_id: String,
    destination_device_id: String,
    source_device_id: String,
    node_id: String,
    version_id: String,
    content_hash: String,
    total_bytes: String,
    destination_path: String,
) -> Result<String, String> {
    let transfer_id = Uuid::parse_str(&transfer_id)
        .map_err(|_| "CloudFusion transfer identifier is invalid".to_owned())?
        .to_string();
    let source_peer_id = PeerId::from_str(&source_peer_id)
        .map_err(|_| "Source device identity is invalid".to_owned())?;
    let total_bytes = total_bytes
        .parse::<u64>()
        .map_err(|_| "CloudFusion file size is invalid".to_owned())?;
    if ticket.trim().is_empty()
        || ticket.len() > 8192
        || content_hash.len() != 64
        || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("CloudFusion transfer authorization is invalid".to_owned());
    }
    let credentials = validate_credentials(api_url, access_token)?;
    let session = get_transfer(&credentials, &transfer_id).await?;
    if session.status != "AUTHORIZED"
        || session.source_device_id != source_device_id
        || session.destination_device_id != destination_device_id
        || session.node_id != node_id
        || session.version_id != version_id
        || !session.content_hash.eq_ignore_ascii_case(&content_hash)
        || session.total_bytes.parse::<u64>().ok() != Some(total_bytes)
    {
        return Err("CloudFusion transfer details no longer match their authorization".to_owned());
    }

    let target = PathBuf::from(destination_path);
    if let Err(error) = validate_destination(&target) {
        let _ = cancel_transfer(&credentials, &transfer_id).await;
        return Err(error);
    }
    let partial = match temporary_path(&target, &transfer_id) {
        Ok(path) => path,
        Err(error) => {
            let _ = cancel_transfer(&credentials, &transfer_id).await;
            return Err(error);
        }
    };
    let output = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .await
        .map_err(|_| "Could not create a temporary file beside the destination".to_owned());
    let output = match output {
        Ok(output) => output,
        Err(error) => {
            let _ = cancel_transfer(&credentials, &transfer_id).await;
            return Err(error);
        }
    };
    drop(output);

    let result = receive_and_finalize(
        &app,
        &manager,
        &credentials,
        &source_peer_id,
        &transfer_id,
        &ticket,
        &content_hash.to_ascii_lowercase(),
        total_bytes,
        &partial,
        &target,
    )
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
        let transport = manager.transfer_path_for_peer(&source_peer_id);
        if update_transfer_state(&credentials, &transfer_id, "FAILED", None, &transport)
            .await
            .is_err()
        {
            let _ = cancel_transfer(&credentials, &transfer_id).await;
        }
    }
    result.map(|()| target.to_string_lossy().into_owned())
}

async fn receive_and_finalize(
    app: &AppHandle,
    manager: &MeshManager,
    credentials: &MeshApiCredentials,
    source_peer_id: &PeerId,
    transfer_id: &str,
    ticket: &str,
    content_hash: &str,
    total_bytes: u64,
    partial: &Path,
    target: &Path,
) -> Result<(), String> {
    let transport = manager.transfer_path_for_peer(source_peer_id);
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .open(partial)
        .await
        .map_err(|_| "Could not open the temporary download file".to_owned())?;
    let mut hasher = Sha256::new();
    let mut offset = 0u64;
    let mut first_request = true;
    let mut last_reported = 0u64;
    loop {
        if !first_request && offset >= total_bytes {
            break;
        }
        let response = manager
            .request_chunk(
                source_peer_id.clone(),
                ChunkRequest {
                    transfer_id: transfer_id.to_owned(),
                    ticket: first_request.then(|| ticket.to_owned()),
                    content_hash: content_hash.to_owned(),
                    total_bytes,
                    offset,
                    max_bytes: MAX_CHUNK_BYTES,
                },
            )
            .await?;
        first_request = false;
        if let Some(error) = response.error.as_ref() {
            return Err(error.clone());
        }
        if response.transfer_id != transfer_id
            || response.offset != offset
            || response.total_bytes != total_bytes
            || !response.content_hash.eq_ignore_ascii_case(content_hash)
            || response.bytes.len() > MAX_CHUNK_BYTES as usize
        {
            return Err("Received a P2P block that did not match the authorized file".to_owned());
        }
        let next_offset = offset
            .checked_add(response.bytes.len() as u64)
            .ok_or_else(|| "P2P transfer byte count overflowed".to_owned())?;
        if next_offset > total_bytes
            || (response.bytes.is_empty() && total_bytes != 0)
            || response.finished != (next_offset == total_bytes)
        {
            return Err("P2P peer returned an incomplete or oversized file block".to_owned());
        }
        output
            .write_all(&response.bytes)
            .await
            .map_err(|_| "Could not write the received file block".to_owned())?;
        hasher.update(&response.bytes);
        offset = next_offset;
        let _ = app.emit(
            "p2p-transfer-progress",
            serde_json::json!({
                "transferId": transfer_id,
                "bytesTransferred": offset.to_string(),
                "totalBytes": total_bytes.to_string(),
                "status": "TRANSFERRING",
                "transport": transport,
            }),
        );
        if offset == total_bytes || offset.saturating_sub(last_reported) >= 1_048_576 {
            update_transfer_state(
                credentials,
                transfer_id,
                "TRANSFERRING",
                Some(offset),
                &transport,
            )
            .await?;
            last_reported = offset;
        }
        if total_bytes == 0 || response.finished {
            break;
        }
    }

    let actual_hash = format!("{:x}", hasher.finalize());
    if offset != total_bytes || !actual_hash.eq_ignore_ascii_case(content_hash) {
        return Err("The received file failed its SHA-256 integrity check".to_owned());
    }
    update_transfer_state(
        credentials,
        transfer_id,
        "VERIFYING",
        Some(total_bytes),
        &transport,
    )
    .await?;
    output
        .flush()
        .await
        .map_err(|_| "Could not flush the received file".to_owned())?;
    output
        .sync_all()
        .await
        .map_err(|_| "Could not safely persist the received file".to_owned())?;
    drop(output);
    tokio::fs::rename(partial, target)
        .await
        .map_err(|_| "Could not atomically move the verified file into place; an existing file was not overwritten".to_owned())?;
    update_transfer_state(
        credentials,
        transfer_id,
        "COMPLETED",
        Some(total_bytes),
        &transport,
    )
    .await?;
    let _ = app.emit(
        "p2p-transfer-progress",
        serde_json::json!({
            "transferId": transfer_id,
            "bytesTransferred": total_bytes.to_string(),
            "totalBytes": total_bytes.to_string(),
            "status": "COMPLETED",
            "transport": transport,
        }),
    );
    Ok(())
}

pub(crate) async fn claim_source_transfer(
    credentials: &MeshApiCredentials,
    transfer_id: &str,
    ticket: &str,
) -> Result<ClaimedTransfer, String> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/p2p/transfers/{transfer_id}/claim",
            credentials.api_url
        ))
        .bearer_auth(&credentials.access_token)
        .json(&serde_json::json!({ "ticket": ticket }))
        .send()
        .await
        .map_err(|_| "CloudFusion could not validate the one-time P2P ticket".to_owned())?;
    if !response.status().is_success() {
        return Err("CloudFusion rejected the one-time P2P ticket".to_owned());
    }
    response
        .json::<ApiEnvelope<ClaimedTransfer>>()
        .await
        .map(|envelope| envelope.data)
        .map_err(|_| "CloudFusion returned an invalid P2P authorization response".to_owned())
}

pub(crate) async fn ensure_source_transfer_active(
    credentials: &MeshApiCredentials,
    transfer_id: &str,
) -> Result<(), String> {
    let transfer = get_transfer(credentials, transfer_id).await?;
    if matches!(transfer.status.as_str(), "CLAIMED" | "TRANSFERRING") {
        Ok(())
    } else {
        Err("CloudFusion transfer is no longer active".to_owned())
    }
}

async fn get_transfer(
    credentials: &MeshApiCredentials,
    transfer_id: &str,
) -> Result<TransferSession, String> {
    let response = reqwest::Client::new()
        .get(format!(
            "{}/p2p/transfers/{transfer_id}",
            credentials.api_url
        ))
        .bearer_auth(&credentials.access_token)
        .send()
        .await
        .map_err(|_| "CloudFusion could not verify this P2P transfer".to_owned())?;
    if !response.status().is_success() {
        return Err("CloudFusion rejected this P2P transfer".to_owned());
    }
    response
        .json::<ApiEnvelope<TransferSession>>()
        .await
        .map(|envelope| envelope.data)
        .map_err(|_| "CloudFusion returned invalid P2P transfer details".to_owned())
}

async fn update_transfer_state(
    credentials: &MeshApiCredentials,
    transfer_id: &str,
    status: &str,
    bytes_transferred: Option<u64>,
    transport: &str,
) -> Result<(), String> {
    let mut payload = serde_json::json!({ "status": status, "transport": transport });
    if let Some(bytes) = bytes_transferred {
        payload["bytesTransferred"] = serde_json::Value::String(bytes.to_string());
    }
    let response = reqwest::Client::new()
        .post(format!(
            "{}/p2p/transfers/{transfer_id}/state",
            credentials.api_url
        ))
        .bearer_auth(&credentials.access_token)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "CloudFusion could not update the P2P transfer status".to_owned())?;
    if !response.status().is_success() {
        return Err("CloudFusion rejected a P2P transfer status update".to_owned());
    }
    Ok(())
}

async fn cancel_transfer(
    credentials: &MeshApiCredentials,
    transfer_id: &str,
) -> Result<(), String> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/p2p/transfers/{transfer_id}/cancel",
            credentials.api_url
        ))
        .bearer_auth(&credentials.access_token)
        .send()
        .await
        .map_err(|_| "Could not cancel the unused P2P authorization".to_owned())?;
    if !response.status().is_success() {
        return Err("CloudFusion rejected P2P authorization cancellation".to_owned());
    }
    Ok(())
}

fn validate_credentials(
    api_url: String,
    access_token: String,
) -> Result<MeshApiCredentials, String> {
    let parsed = reqwest::Url::parse(&api_url)
        .map_err(|_| "CloudFusion API address is invalid".to_owned())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("CloudFusion API address must use HTTP or HTTPS".to_owned());
    }
    if access_token.trim().is_empty() || access_token.len() > 16_384 {
        return Err("Your CloudFusion session has expired; sign in again".to_owned());
    }
    Ok(MeshApiCredentials {
        api_url: api_url.trim_end_matches('/').to_owned(),
        access_token,
    })
}

fn validate_destination(target: &Path) -> Result<(), String> {
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Choose a valid file name for the download".to_owned())?;
    if file_name.is_empty() || file_name == "." || file_name == ".." {
        return Err("Choose a valid file name for the download".to_owned());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Choose a folder for the downloaded file".to_owned())?;
    if !parent.is_dir() {
        return Err("The selected download folder no longer exists".to_owned());
    }
    if target.exists() {
        return Err("A file with that name already exists; choose another name".to_owned());
    }
    Ok(())
}

fn temporary_path(target: &Path, transfer_id: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Choose a folder for the downloaded file".to_owned())?;
    Ok(parent.join(format!(".cloudfusion-{transfer_id}.partial")))
}

#[cfg(test)]
mod tests {
    use super::validate_destination;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn download_destination_must_be_in_an_existing_directory_and_not_overwrite() {
        let directory = std::env::temp_dir().join(format!("cloudfusion-p2p-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).expect("test destination exists");
        let file = directory.join("received.bin");
        assert!(validate_destination(&file).is_ok());
        fs::write(&file, b"keep").expect("existing user file writes");
        assert!(validate_destination(&file).is_err());
        assert_eq!(fs::read(&file).expect("existing file remains"), b"keep");
        fs::remove_dir_all(PathBuf::from(directory)).expect("test directory cleans up");
    }
}
