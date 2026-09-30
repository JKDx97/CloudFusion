use crate::{build_client, config_path, get_json, load_config, refresh_session, save_config};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::StreamExt;
use reqwest::{header, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const MAX_SYNC_ROOTS: usize = 8;
const MAX_SYNC_FILES: usize = 50_000;
const MAX_SYNC_DEPTH: usize = 128;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NodeSyncRoot {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) remote_node_id: String,
}

#[derive(Clone, Debug)]
pub(crate) struct P2pLocalFile {
    pub(crate) node_id: String,
    pub(crate) version_id: String,
    pub(crate) checksum: String,
    pub(crate) size: u64,
    pub(crate) path: PathBuf,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncedFile {
    remote_path: String,
    node_id: String,
    version_id: String,
    checksum: String,
    size: u64,
    version_number: u64,
    #[serde(default)]
    local_modified_ns: Option<u128>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifest {
    roots: BTreeMap<String, BTreeMap<String, SyncedFile>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteNode {
    id: String,
    name: String,
    #[serde(rename = "type")]
    node_type: String,
    current_version_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteVersion {
    id: String,
    version_number: u64,
    size: u64,
    checksum: String,
    current: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResult {
    node: UploadedNode,
    version: Option<UploadedVersion>,
    conflict: bool,
    #[serde(default)]
    replicas: usize,
    warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadedNode {
    id: String,
    name: String,
    current_version_id: Option<String>,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadedVersion {
    id: String,
    checksum: String,
    size: u64,
    version_number: u64,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    data: T,
}

struct RemoteFile {
    relative_path: String,
    node: RemoteNode,
}

pub(crate) async fn run_command(mut args: impl Iterator<Item = String>) -> Result<(), String> {
    let action = args.next().ok_or_else(usage)?;
    match action.as_str() {
        "add" => {
            let mut path = None;
            let mut remote_id = None;
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--path" if path.is_none() => path = args.next(),
                    "--remote-node-id" if remote_id.is_none() => remote_id = args.next(),
                    _ => return Err(usage()),
                }
            }
            add_root(path.ok_or_else(usage)?, remote_id.ok_or_else(usage)?).await
        }
        "list" => {
            if args.next().is_some() {
                return Err(usage());
            }
            let config = load_config()?;
            if config.sync_roots.is_empty() {
                println!("No sync folders configured. Add one with `cloudfusion-node sync add`.");
            }
            for root in config.sync_roots {
                println!("{}  {}  ->  {}", root.id, root.path, root.remote_node_id);
            }
            Ok(())
        }
        "remove" => {
            let mut root_id = None;
            while let Some(arg) = args.next() {
                if arg == "--root-id" && root_id.is_none() {
                    root_id = args.next();
                } else {
                    return Err(usage());
                }
            }
            remove_root(&root_id.ok_or_else(usage)?)
        }
        _ => Err(usage()),
    }
}

fn usage() -> String {
    "Usage: cloudfusion-node sync add --path <local-folder> --remote-node-id <folder-uuid>\n       cloudfusion-node sync list\n       cloudfusion-node sync remove --root-id <root-uuid>".to_owned()
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    fn parts(path: &Path) -> Vec<String> {
        path.components()
            .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
            .collect()
    }
    #[cfg(not(windows))]
    fn parts(path: &Path) -> Vec<String> {
        path.components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect()
    }
    let left = parts(left);
    let right = parts(right);
    left.starts_with(&right) || right.starts_with(&left)
}

async fn add_root(path: String, remote_node_id: String) -> Result<(), String> {
    Uuid::parse_str(&remote_node_id).map_err(|_| "Remote folder ID must be a UUID".to_owned())?;
    let input_path = PathBuf::from(&path);
    let metadata = fs::symlink_metadata(&input_path)
        .map_err(|_| "Local sync folder does not exist".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(
            "Local sync path must be an existing directory, not a symbolic link".to_owned(),
        );
    }
    let canonical_path = fs::canonicalize(&input_path)
        .map_err(|_| "Could not resolve the local sync folder".to_owned())?;
    if canonical_path.to_string_lossy().len() > 2048 {
        return Err("Local sync folder path is too long".to_owned());
    }

    let mut config = load_config()?;
    if config.sync_roots.len() >= MAX_SYNC_ROOTS {
        return Err(format!(
            "At most {MAX_SYNC_ROOTS} local sync folders can be configured"
        ));
    }
    if config.sync_roots.iter().any(|root| {
        paths_overlap(Path::new(&root.path), &canonical_path)
            || root.remote_node_id == remote_node_id
    }) {
        return Err(
            "This local folder or CloudFusion destination is already used by another sync root"
                .to_owned(),
        );
    }
    let client = build_client()?;
    let session = refresh_session(&client, &mut config).await?;
    let node: RemoteNode = get_json(
        &client,
        &config.api_url,
        &format!("/virtual-drive/nodes/{remote_node_id}"),
        &session.access_token,
    )
    .await?;
    if node.id != remote_node_id || node.node_type != "FOLDER" {
        return Err("The selected CloudFusion destination is not an accessible folder".to_owned());
    }
    let root = NodeSyncRoot {
        id: Uuid::new_v4().to_string(),
        path: canonical_path.to_string_lossy().into_owned(),
        remote_node_id,
    };
    config.sync_roots.push(root.clone());
    save_config(&config)?;
    println!(
        "Sync folder added: {} -> {} ({})",
        root.path, node.name, root.id
    );
    Ok(())
}

fn remove_root(root_id: &str) -> Result<(), String> {
    Uuid::parse_str(root_id).map_err(|_| "Sync root ID must be a UUID".to_owned())?;
    let mut config = load_config()?;
    let original_len = config.sync_roots.len();
    config.sync_roots.retain(|root| root.id != root_id);
    if config.sync_roots.len() == original_len {
        return Err("Sync folder not found".to_owned());
    }
    save_config(&config)?;
    let mut manifest = load_manifest()?;
    manifest.roots.remove(root_id);
    save_manifest(&manifest)?;
    println!("Sync folder removed. Local files were left untouched.");
    Ok(())
}

pub(crate) async fn run_daemon() -> Result<(), String> {
    let mut config = load_config()?;
    if config.refresh_token.is_none() {
        return Err("Node is not paired; run cloudfusion-node login first".to_owned());
    }
    if config.sync_roots.is_empty() {
        return Err(
            "No sync folders configured; add a folder with `cloudfusion-node sync add`".to_owned(),
        );
    }
    println!(
        "CloudFusion NAS sync running for {} folder(s). Press Ctrl+C to stop.",
        config.sync_roots.len()
    );
    let client = build_client()?;
    let session = refresh_session(&client, &mut config).await?;
    let initial_expiry = token_expiration(&session.access_token)
        .unwrap_or_else(unix_time_seconds)
        .max(unix_time_seconds());
    let mut access_token = Some((session.access_token.clone(), initial_expiry));
    let (credentials_tx, credentials_rx) = watch::channel(crate::mesh::MeshCredentials {
        api_url: config.api_url.clone(),
        access_token: session.access_token,
    });
    let (mesh_stop_tx, mesh_stop_rx) = watch::channel(false);
    let mut mesh_task = tokio::spawn(crate::mesh::run_mesh(
        config.clone(),
        credentials_rx,
        mesh_stop_rx,
    ));
    let mut ticker = tokio::time::interval(Duration::from_secs(30));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let shutdown = tokio::signal::ctrl_c();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => {
                let _ = mesh_stop_tx.send(true);
                let _ = (&mut mesh_task).await;
                println!("CloudFusion NAS sync stopped.");
                return Ok(());
            }
            result = &mut mesh_task => {
                return match result {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(error)) => Err(format!("P2P device service stopped: {error}")),
                    Err(_) => Err("P2P device service failed unexpectedly".to_owned()),
                };
            }
            _ = ticker.tick() => {
                let now = unix_time_seconds();
                if access_token.as_ref().is_none_or(|(_, exp)| *exp <= now.saturating_add(60)) {
                    let session = refresh_session(&client, &mut config).await?;
                    let expires = token_expiration(&session.access_token).unwrap_or(now);
                    access_token = Some((session.access_token.clone(), expires));
                    credentials_tx.send_replace(crate::mesh::MeshCredentials {
                        api_url: config.api_url.clone(),
                        access_token: session.access_token,
                    });
                }
                let token = access_token.as_ref().map(|(value, _)| value.as_str()).unwrap_or_default();
                sync_cycle(&client, &config.api_url, token, &config.sync_roots).await;
            }
        }
    }
}

async fn sync_cycle(client: &Client, api_url: &str, token: &str, roots: &[NodeSyncRoot]) {
    for root in roots {
        match sync_root(client, api_url, token, root).await {
            Ok((uploaded, downloaded, conflicts)) => println!(
                "Sync {}: {uploaded} uploaded, {downloaded} downloaded, {conflicts} conflict copy/copies",
                root.path
            ),
            Err(error) => eprintln!("Sync folder {} failed: {error}", root.path),
        }
    }
}

fn unix_time_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn token_expiration(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).ok()?;
    #[derive(Deserialize)]
    struct Claims {
        exp: u64,
    }
    serde_json::from_slice::<Claims>(&bytes)
        .ok()
        .map(|claims| claims.exp)
}

async fn sync_root(
    client: &Client,
    api_url: &str,
    token: &str,
    root: &NodeSyncRoot,
) -> Result<(usize, usize, usize), String> {
    validate_root(root)?;
    let mut manifest = load_manifest()?;
    let prior = manifest.roots.get(&root.id).cloned().unwrap_or_default();
    let (remote_files, remote_folders) =
        list_remote_tree(client, api_url, token, &root.remote_node_id).await?;
    for folder in remote_folders {
        create_local_directories(&root.path, &folder)?;
    }
    let local_files = collect_local_files(&root.path, &prior)?;
    let mut uploaded = 0;
    let mut downloaded = 0;
    let mut conflicts = 0;
    let mut updated = prior.clone();

    for remote in &remote_files {
        let version_id = remote
            .node
            .current_version_id
            .as_deref()
            .ok_or_else(|| "Remote file has no current version".to_owned())?;
        let old_entry = prior
            .values()
            .find(|entry| entry.remote_path == remote.relative_path);
        let local_path = old_entry
            .map(|entry| entry_path_for_remote(&prior, entry))
            .unwrap_or_else(|| remote.relative_path.clone());
        let local_state = local_files
            .get(&local_path)
            .map(|(path, size, checksum, _)| (path, *size, checksum.as_str()));
        let remote_version = if old_entry.is_some_and(|entry| entry.version_id == version_id) {
            RemoteVersion {
                id: version_id.to_owned(),
                version_number: old_entry.unwrap().version_number,
                size: old_entry.unwrap().size,
                checksum: old_entry.unwrap().checksum.clone(),
                current: true,
            }
        } else {
            get_current_version(client, api_url, token, &remote.node.id).await?
        };
        if !remote_version.current
            || remote_version.id != version_id
            || !valid_checksum(&remote_version.checksum)
        {
            return Err("CloudFusion returned inconsistent version metadata".to_owned());
        }

        if let Some((_, size, checksum)) = local_state {
            if size == remote_version.size
                && checksum.eq_ignore_ascii_case(&remote_version.checksum)
            {
                updated.insert(local_path.clone(), make_synced(remote, &remote_version));
                continue;
            }
        }

        if let Some(previous) = old_entry {
            if let Some((local_file, size, checksum)) = local_state {
                if previous.version_id == version_id {
                    if !same_content(previous, size, checksum) {
                        upload_local(
                            client,
                            api_url,
                            token,
                            root,
                            &local_path,
                            local_file,
                            Some(previous),
                            &mut updated,
                        )
                        .await?;
                        uploaded += 1;
                    }
                    continue;
                }
                if same_content(previous, size, checksum) {
                    download_remote(
                        client,
                        api_url,
                        token,
                        root,
                        remote,
                        &remote_version,
                        &local_path,
                        Some(previous),
                    )
                    .await?;
                    updated.insert(local_path, make_synced(remote, &remote_version));
                    downloaded += 1;
                    continue;
                }
                let conflict_path =
                    unique_conflict_path(&root.path, &local_path, &remote_version.id)?;
                download_remote(
                    client,
                    api_url,
                    token,
                    root,
                    remote,
                    &remote_version,
                    &conflict_path,
                    None,
                )
                .await?;
                updated.insert(conflict_path, make_synced(remote, &remote_version));
                upload_local(
                    client,
                    api_url,
                    token,
                    root,
                    &local_path,
                    local_file,
                    Some(previous),
                    &mut updated,
                )
                .await?;
                uploaded += 1;
                downloaded += 1;
                conflicts += 1;
                continue;
            }
            // A local deletion is intentionally not propagated; leave its cloud copy intact.
            continue;
        }

        let destination = if local_state.is_some() {
            unique_conflict_path(&root.path, &remote.relative_path, &remote_version.id)?
        } else {
            remote.relative_path.clone()
        };
        download_remote(
            client,
            api_url,
            token,
            root,
            remote,
            &remote_version,
            &destination,
            None,
        )
        .await?;
        if destination != remote.relative_path {
            conflicts += 1;
        }
        updated.insert(destination, make_synced(remote, &remote_version));
        downloaded += 1;
    }

    let current_remote_paths = remote_files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<std::collections::HashSet<_>>();
    for (relative, (path, size, checksum, _)) in &local_files {
        if updated
            .get(relative)
            .is_some_and(|synced| same_content(synced, *size, checksum))
        {
            continue;
        }
        if let Some(previous) = prior.get(relative) {
            if !current_remote_paths.contains(previous.remote_path.as_str()) {
                continue;
            }
            let remote = remote_files
                .iter()
                .find(|file| file.relative_path == previous.remote_path)
                .expect("path set and list agree");
            if remote.node.current_version_id.as_deref() == Some(previous.version_id.as_str())
                && same_content(previous, *size, checksum)
            {
                continue;
            }
            if remote.node.current_version_id.as_deref() == Some(previous.version_id.as_str()) {
                upload_local(
                    client,
                    api_url,
                    token,
                    root,
                    relative,
                    path,
                    Some(previous),
                    &mut updated,
                )
                .await?;
                uploaded += 1;
            }
        } else {
            let expected = remote_files
                .iter()
                .find(|file| file.relative_path == *relative);
            if expected.is_none() {
                upload_local(
                    client,
                    api_url,
                    token,
                    root,
                    relative,
                    path,
                    None,
                    &mut updated,
                )
                .await?;
                uploaded += 1;
            } else {
                // Preserve a pre-existing local file as an explicit CloudFusion conflict copy.
                upload_local(
                    client,
                    api_url,
                    token,
                    root,
                    relative,
                    path,
                    None,
                    &mut updated,
                )
                .await?;
                uploaded += 1;
                conflicts += 1;
            }
        }
    }
    for (relative, state) in &mut updated {
        state.local_modified_ns = local_modified_ns(&root.path, relative).ok();
    }
    if updated != prior {
        manifest.roots.insert(root.id.clone(), updated);
        save_manifest(&manifest)?;
    }
    Ok((uploaded, downloaded, conflicts))
}

fn entry_path_for_remote(manifest: &BTreeMap<String, SyncedFile>, entry: &SyncedFile) -> String {
    manifest
        .iter()
        .find_map(|(local, value)| (value.remote_path == entry.remote_path).then(|| local.clone()))
        .unwrap_or_else(|| entry.remote_path.clone())
}

fn make_synced(remote: &RemoteFile, version: &RemoteVersion) -> SyncedFile {
    SyncedFile {
        remote_path: remote.relative_path.clone(),
        node_id: remote.node.id.clone(),
        version_id: version.id.clone(),
        checksum: version.checksum.clone(),
        size: version.size,
        version_number: version.version_number,
        local_modified_ns: None,
    }
}

fn same_content(previous: &SyncedFile, size: u64, checksum: &str) -> bool {
    previous.size == size && previous.checksum.eq_ignore_ascii_case(checksum)
}

async fn list_remote_tree(
    client: &Client,
    api_url: &str,
    token: &str,
    root_id: &str,
) -> Result<(Vec<RemoteFile>, Vec<String>), String> {
    let mut pending = VecDeque::from([(root_id.to_owned(), String::new(), 0usize)]);
    let mut files = Vec::new();
    let mut folders = Vec::new();
    let mut seen = 0usize;
    while let Some((folder_id, prefix, depth)) = pending.pop_front() {
        if depth >= MAX_SYNC_DEPTH {
            return Err("Remote folder nesting exceeds the safe sync limit".to_owned());
        }
        let children: Vec<RemoteNode> = get_json(
            client,
            api_url,
            &format!("/virtual-drive/nodes/{folder_id}/children"),
            token,
        )
        .await?;
        for node in children {
            seen += 1;
            if seen > MAX_SYNC_FILES {
                return Err("Remote folder tree exceeds the 50,000 item sync limit".to_owned());
            }
            let relative = if prefix.is_empty() {
                node.name.clone()
            } else {
                format!("{prefix}/{}", node.name)
            };
            validate_relative_path(&relative)?;
            match node.node_type.as_str() {
                "FOLDER" => {
                    folders.push(relative.clone());
                    pending.push_back((node.id.clone(), relative, depth + 1));
                }
                "FILE" if node.current_version_id.is_some() => files.push(RemoteFile {
                    relative_path: relative,
                    node,
                }),
                "FILE" => {}
                _ => return Err("CloudFusion returned an unsupported drive item type".to_owned()),
            }
        }
    }
    Ok((files, folders))
}

async fn get_current_version(
    client: &Client,
    api_url: &str,
    token: &str,
    node_id: &str,
) -> Result<RemoteVersion, String> {
    let versions: Vec<RemoteVersion> = get_json(
        client,
        api_url,
        &format!("/virtual-drive/nodes/{node_id}/versions"),
        token,
    )
    .await?;
    versions
        .into_iter()
        .find(|version| version.current)
        .ok_or_else(|| "CloudFusion file has no current version".to_owned())
}

async fn upload_local(
    client: &Client,
    api_url: &str,
    token: &str,
    root: &NodeSyncRoot,
    relative: &str,
    path: &Path,
    previous: Option<&SyncedFile>,
    manifest: &mut BTreeMap<String, SyncedFile>,
) -> Result<(), String> {
    validate_relative_path(relative)?;
    let (initial_size, initial_checksum) = hash_file(path).await?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "Could not open local sync file".to_owned())?;
    let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
    let encoded_path = URL_SAFE_NO_PAD.encode(
        previous
            .map(|value| value.remote_path.as_str())
            .unwrap_or(relative)
            .as_bytes(),
    );
    let mut request = client
        .post(format!(
            "{}/virtual-drive/sync-upload",
            api_url.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header("x-cloudfusion-sync-root", &root.remote_node_id)
        .header("x-cloudfusion-sync-path", encoded_path)
        .header("x-cloudfusion-sync-checksum", &initial_checksum);
    if let Some(previous) = previous {
        request = request.header("x-cloudfusion-sync-version", &previous.version_id);
    }
    let response = request
        .body(body)
        .send()
        .await
        .map_err(|_| "Could not connect to CloudFusion for sync upload".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "CloudFusion rejected sync upload (HTTP {})",
            response.status()
        ));
    }
    let uploaded = response
        .json::<ApiEnvelope<UploadResult>>()
        .await
        .map_err(|_| "CloudFusion returned an invalid sync receipt".to_owned())?
        .data;
    if uploaded.node.status == "UNAVAILABLE"
        || (uploaded.replicas == 0 && uploaded.warning.is_some())
    {
        return Err(uploaded
            .warning
            .unwrap_or_else(|| "No cloud provider is available for this upload".to_owned()));
    }
    let version = uploaded
        .version
        .ok_or_else(|| "CloudFusion did not return the uploaded file version".to_owned())?;
    let (final_size, final_checksum) = hash_file(path).await?;
    if initial_size != final_size
        || !initial_checksum.eq_ignore_ascii_case(&final_checksum)
        || version.size != final_size
        || !version.checksum.eq_ignore_ascii_case(&final_checksum)
    {
        return Err(
            "Local file changed during upload; it will be retried on the next sync cycle"
                .to_owned(),
        );
    }
    let remote_path = if uploaded.conflict {
        let requested = previous
            .map(|value| value.remote_path.as_str())
            .unwrap_or(relative);
        requested
            .rsplit_once('/')
            .map(|(parent, _)| format!("{parent}/{}", uploaded.node.name))
            .unwrap_or_else(|| uploaded.node.name.clone())
    } else {
        previous
            .map(|value| value.remote_path.clone())
            .unwrap_or_else(|| relative.to_owned())
    };
    validate_relative_path(&remote_path)?;
    let version_id = uploaded.node.current_version_id.unwrap_or(version.id);
    Uuid::parse_str(&version_id)
        .map_err(|_| "CloudFusion returned an invalid file version ID".to_owned())?;
    manifest.insert(
        relative.to_owned(),
        SyncedFile {
            remote_path,
            node_id: uploaded.node.id,
            version_id,
            checksum: final_checksum,
            size: final_size,
            version_number: version.version_number,
            local_modified_ns: local_modified_ns_from_path(path).ok(),
        },
    );
    Ok(())
}

async fn download_remote(
    client: &Client,
    api_url: &str,
    token: &str,
    root: &NodeSyncRoot,
    remote: &RemoteFile,
    version: &RemoteVersion,
    target_relative: &str,
    replace_baseline: Option<&SyncedFile>,
) -> Result<(), String> {
    validate_relative_path(target_relative)?;
    let target = safe_target(&root.path, target_relative, true)?;
    let existing = fs::symlink_metadata(&target).ok();
    if existing.is_some() && replace_baseline.is_none() {
        return Err("Refusing to overwrite a local sync file".to_owned());
    }
    if existing
        .as_ref()
        .is_some_and(|meta| meta.file_type().is_symlink() || !meta.is_file())
    {
        return Err("Local sync target is not a safe regular file".to_owned());
    }
    let stage = target
        .parent()
        .ok_or_else(|| "Invalid local sync target".to_owned())?
        .join(format!(
            ".cloudfusion-node-{}.download",
            Uuid::new_v4().simple()
        ));
    let endpoint = format!(
        "{}/virtual-drive/nodes/{}/versions/{}/download",
        api_url.trim_end_matches('/'),
        remote.node.id,
        version.id
    );
    let response = client
        .get(endpoint)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| "Could not connect to CloudFusion for sync download".to_owned())?;
    if !response.status().is_success() {
        return Err(format!(
            "CloudFusion rejected sync download (HTTP {})",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length != version.size)
    {
        return Err("CloudFusion advertised an unexpected download size".to_owned());
    }
    let mut output = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&stage)
        .await
        .map_err(|_| "Could not create the temporary sync download".to_owned())?;
    let result = async {
        let mut stream = response.bytes_stream();
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "Sync download was interrupted".to_owned())?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "Downloaded file is too large".to_owned())?;
            if received > version.size {
                return Err("CloudFusion sent more bytes than the version size".to_owned());
            }
            hasher.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|_| "Could not write a downloaded file block".to_owned())?;
        }
        output
            .flush()
            .await
            .map_err(|_| "Could not finish the temporary download".to_owned())?;
        output
            .sync_all()
            .await
            .map_err(|_| "Could not persist the temporary download".to_owned())?;
        if received != version.size
            || hex(&hasher.finalize()).to_lowercase() != version.checksum.to_lowercase()
        {
            return Err("Downloaded file failed size or SHA-256 verification".to_owned());
        }
        Ok::<(), String>(())
    }
    .await;
    drop(output);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&stage).await;
        return Err(error);
    }

    let current = fs::symlink_metadata(&target).ok();
    match (replace_baseline, current.as_ref()) {
        (None, None) => {}
        (None, Some(_)) => {
            let _ = fs::remove_file(&stage);
            return Err("A local file appeared during sync; it was not overwritten".to_owned());
        }
        (Some(_), None) => {
            let _ = fs::remove_file(&stage);
            return Err(
                "The local baseline disappeared during sync; remote update was deferred".to_owned(),
            );
        }
        (Some(_), Some(metadata)) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            let _ = fs::remove_file(&stage);
            return Err("Local sync target became unsafe during download".to_owned());
        }
        (Some(baseline), Some(metadata)) => {
            let (size, checksum) = match hash_file(&target).await {
                Ok(value) => value,
                Err(error) => {
                    let _ = fs::remove_file(&stage);
                    return Err(error);
                }
            };
            if !same_content(baseline, size, &checksum) || metadata.len() != baseline.size {
                let _ = fs::remove_file(&stage);
                return Err(
                    "Local file changed during sync; remote update was deferred to preserve it"
                        .to_owned(),
                );
            }
        }
    }
    let backup = if current.is_some() {
        let path = target.parent().unwrap().join(format!(
            ".cloudfusion-node-{}.backup",
            Uuid::new_v4().simple()
        ));
        if fs::rename(&target, &path).is_err() {
            let _ = fs::remove_file(&stage);
            return Err("Could not safely preserve the previous local file".to_owned());
        }
        Some(path)
    } else {
        None
    };
    if let Err(error) = fs::rename(&stage, &target) {
        if let Some(backup_path) = &backup {
            let _ = fs::rename(backup_path, &target);
        }
        let _ = fs::remove_file(&stage);
        return Err(format!("Could not install verified sync file: {error}"));
    }
    if let Some(backup_path) = backup {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

async fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "Could not read local sync file".to_owned())?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|_| "Could not read local sync file".to_owned())?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| "Local file is too large".to_owned())?;
        hasher.update(&buffer[..count]);
    }
    Ok((size, hex(&hasher.finalize())))
}

fn hash_file_sync(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path).map_err(|_| "Could not read local sync file".to_owned())?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Could not read local sync file".to_owned())?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| "Local file is too large".to_owned())?;
        hasher.update(&buffer[..count]);
    }
    Ok((size, hex(&hasher.finalize())))
}

fn collect_local_files(
    root: &str,
    manifest: &BTreeMap<String, SyncedFile>,
) -> Result<BTreeMap<String, (PathBuf, u64, String, u128)>, String> {
    let root_path = PathBuf::from(root);
    let metadata = fs::symlink_metadata(&root_path)
        .map_err(|_| "Local sync folder is unavailable".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Local sync folder is no longer a safe directory".to_owned());
    }
    let canonical_root = fs::canonicalize(&root_path)
        .map_err(|_| "Could not resolve local sync folder".to_owned())?;
    let mut stack = vec![canonical_root.clone()];
    let mut files = BTreeMap::new();
    while let Some(directory) = stack.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|_| "Could not scan local sync folder".to_owned())?
        {
            let entry = entry.map_err(|_| "Could not inspect local sync item".to_owned())?;
            let kind = entry
                .file_type()
                .map_err(|_| "Could not inspect local sync item".to_owned())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(&canonical_root)
                .map_err(|_| "Local sync path escaped its root".to_owned())?
                .to_string_lossy()
                .replace('\\', "/");
            validate_relative_path(&relative)?;
            if relative
                .split('/')
                .any(|part| part.starts_with(".cloudfusion-node-"))
            {
                continue;
            }
            let canonical = fs::canonicalize(&path)
                .map_err(|_| "Could not resolve local sync file".to_owned())?;
            if !canonical.starts_with(&canonical_root) {
                return Err("Local sync path escaped its root".to_owned());
            }
            let size = fs::metadata(&canonical)
                .map_err(|_| "Could not inspect local sync file".to_owned())?
                .len();
            let modified_ns = local_modified_ns_from_path(&canonical)?;
            let checksum = match manifest.get(&relative) {
                Some(previous)
                    if previous.size == size && previous.local_modified_ns == Some(modified_ns) =>
                {
                    previous.checksum.clone()
                }
                _ => hash_file_sync(&canonical)?.1,
            };
            files.insert(relative, (canonical, size, checksum, modified_ns));
            if files.len() > MAX_SYNC_FILES {
                return Err("Local sync folder exceeds the 50,000 file limit".to_owned());
            }
        }
    }
    Ok(files)
}

fn local_modified_ns(root: &str, relative: &str) -> Result<u128, String> {
    let path = safe_target(root, relative, false)?;
    local_modified_ns_from_path(&path)
}

fn local_modified_ns_from_path(path: &Path) -> Result<u128, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Could not inspect local sync file timestamp".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Local sync item is not a regular file".to_owned());
    }
    metadata
        .modified()
        .map_err(|_| "Could not read local sync file timestamp".to_owned())?
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|_| "Local sync file timestamp is invalid".to_owned())
}

fn safe_target(root: &str, relative: &str, create_parents: bool) -> Result<PathBuf, String> {
    let segments = validate_relative_path(relative)?;
    let root = PathBuf::from(root);
    let root_metadata =
        fs::symlink_metadata(&root).map_err(|_| "Local sync folder is unavailable".to_owned())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Local sync root is not a safe directory".to_owned());
    }
    let canonical_root =
        fs::canonicalize(&root).map_err(|_| "Could not resolve local sync root".to_owned())?;
    let mut parent = canonical_root.clone();
    for segment in &segments[..segments.len() - 1] {
        parent.push(segment);
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("Local sync path contains an unsafe directory".to_owned())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound && create_parents => {
                fs::create_dir(&parent)
                    .map_err(|_| "Could not create local sync folder".to_owned())?
            }
            Err(_) => return Err("Local sync parent directory is unavailable".to_owned()),
        }
        parent = fs::canonicalize(&parent)
            .map_err(|_| "Could not resolve local sync parent".to_owned())?;
        if !parent.starts_with(&canonical_root) {
            return Err("Local sync path escaped its root".to_owned());
        }
    }
    let target = parent.join(segments[segments.len() - 1]);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Local sync target is not a regular file".to_owned());
        }
        if !fs::canonicalize(&target)
            .map_err(|_| "Could not resolve local sync target".to_owned())?
            .starts_with(&canonical_root)
        {
            return Err("Local sync target escaped its root".to_owned());
        }
    }
    Ok(target)
}

fn create_local_directories(root: &str, relative: &str) -> Result<(), String> {
    let segments = validate_relative_path(relative)?;
    let canonical_root =
        fs::canonicalize(root).map_err(|_| "Could not resolve local sync root".to_owned())?;
    let mut current = canonical_root.clone();
    for segment in segments {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("Remote folder collides with an unsafe local item".to_owned())
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => fs::create_dir(&current)
                .map_err(|_| "Could not create a local sync folder".to_owned())?,
            Err(_) => return Err("Could not inspect a local sync folder".to_owned()),
        }
        current = fs::canonicalize(&current)
            .map_err(|_| "Could not resolve local sync folder".to_owned())?;
        if !current.starts_with(&canonical_root) {
            return Err("Remote folder escaped the local sync root".to_owned());
        }
    }
    Ok(())
}

fn unique_conflict_path(root: &str, original: &str, version_id: &str) -> Result<String, String> {
    let (parent, name) = original
        .rsplit_once('/')
        .map(|(p, n)| (Some(p), n))
        .unwrap_or((None, original));
    let source = Path::new(name);
    let stem = source.file_stem().and_then(|v| v.to_str()).unwrap_or(name);
    let extension = source
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| format!(".{v}"))
        .unwrap_or_default();
    let tag = version_id.replace('-', "");
    for attempt in 0..100u32 {
        let marker = if attempt == 0 {
            format!(" (CloudFusion conflict {})", &tag[..tag.len().min(8)])
        } else {
            format!(
                " (CloudFusion conflict {}-{attempt})",
                &tag[..tag.len().min(8)]
            )
        };
        let suffix = format!("{marker}{extension}");
        let max_chars = 240usize.saturating_sub(suffix.encode_utf16().count());
        let short_stem = stem
            .chars()
            .scan(0usize, |count, ch| {
                *count += ch.len_utf16();
                (*count <= max_chars).then_some(ch)
            })
            .collect::<String>();
        let name = format!(
            "{}{}",
            if short_stem.is_empty() {
                "file"
            } else {
                &short_stem
            },
            suffix
        );
        let candidate = parent.map(|p| format!("{p}/{name}")).unwrap_or(name);
        validate_relative_path(&candidate)?;
        let target = safe_target(root, &candidate, true)?;
        if fs::symlink_metadata(&target).is_err() {
            return Ok(candidate);
        }
    }
    Err("Could not allocate a safe local conflict filename".to_owned())
}

fn validate_root(root: &NodeSyncRoot) -> Result<(), String> {
    Uuid::parse_str(&root.id).map_err(|_| "Invalid local sync root ID".to_owned())?;
    Uuid::parse_str(&root.remote_node_id)
        .map_err(|_| "Invalid CloudFusion folder ID".to_owned())?;
    if root.path.len() > 2048 {
        return Err("Local sync root path is too long".to_owned());
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<Vec<&str>, String> {
    if value.is_empty() || value.len() > 4096 || value.starts_with('/') || value.contains('\\') {
        return Err("Invalid sync relative path".to_owned());
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() > MAX_SYNC_DEPTH
        || segments.iter().any(|segment| {
            segment.is_empty()
                || segment.encode_utf16().count() > 255
                || segment.trim() != *segment
                || *segment == "."
                || *segment == ".."
                || segment
                    .chars()
                    .any(|ch| ch.is_control() || ['<', '>', ':', '"', '|', '?', '*'].contains(&ch))
                || is_windows_device_name(segment)
        })
    {
        return Err("Invalid sync relative path".to_owned());
    }
    Ok(segments)
}

fn is_windows_device_name(segment: &str) -> bool {
    let base = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .trim_end()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
        })
}

fn valid_checksum(checksum: &str) -> bool {
    checksum.len() == 64 && checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn manifest_path() -> Result<PathBuf, String> {
    let config = config_path()?;
    let parent = config
        .parent()
        .ok_or_else(|| "Could not resolve node configuration directory".to_owned())?;
    Ok(parent.join("sync-manifest.json"))
}

fn load_manifest() -> Result<SyncManifest, String> {
    let path = manifest_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve node configuration directory".to_owned())?;
    validate_manifest_parent(parent)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(SyncManifest::default()),
        Err(_) => return Err("Could not inspect node sync manifest".to_owned()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("Node sync manifest is not a safe file".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Node sync manifest must be restricted to its owner (0600)".to_owned());
        }
    }
    serde_json::from_slice(
        &fs::read(path).map_err(|_| "Could not read node sync manifest".to_owned())?,
    )
    .map_err(|_| "Node sync manifest is invalid".to_owned())
}

pub(crate) async fn verified_local_files(
    roots: &[NodeSyncRoot],
) -> Result<Vec<P2pLocalFile>, String> {
    let manifest = load_manifest()?;
    let mut files = Vec::new();
    for root in roots {
        validate_root(root)?;
        let Some(entries) = manifest.roots.get(&root.id) else {
            continue;
        };
        for (relative, entry) in entries {
            let path = match safe_target(&root.path, relative, false) {
                Ok(path) => path,
                Err(_) => continue,
            };
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
                    metadata
                }
                _ => continue,
            };
            if metadata.len() != entry.size {
                continue;
            }
            let modified_ns = match local_modified_ns_from_path(&path) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let (size, checksum) = if entry.local_modified_ns == Some(modified_ns) {
                (entry.size, entry.checksum.clone())
            } else {
                match hash_file(&path).await {
                    Ok(value) => value,
                    Err(_) => continue,
                }
            };
            if size == entry.size && checksum.eq_ignore_ascii_case(&entry.checksum) {
                files.push(P2pLocalFile {
                    node_id: entry.node_id.clone(),
                    version_id: entry.version_id.clone(),
                    checksum,
                    size,
                    path,
                });
            }
        }
    }
    Ok(files)
}

fn save_manifest(manifest: &SyncManifest) -> Result<(), String> {
    let path = manifest_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve node configuration directory".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|_| "Could not create node configuration directory".to_owned())?;
    validate_manifest_parent(parent)?;
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Node sync manifest is not a safe file".to_owned());
        }
    }
    let bytes = serde_json::to_vec(manifest)
        .map_err(|_| "Could not encode node sync manifest".to_owned())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Node sync manifest exceeds its safe size limit".to_owned());
    }
    let temporary = parent.join(format!(".sync-manifest-{}.tmp", Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> io::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("Could not securely save node sync manifest".to_owned());
    }
    Ok(())
}

fn validate_manifest_parent(parent: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(parent)
        .map_err(|_| "Could not inspect node configuration directory".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Node configuration directory is not a safe directory".to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Node sync metadata directory must be owner-only (0700)".to_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{unique_conflict_path, validate_relative_path, SyncManifest, SyncedFile};
    use std::collections::BTreeMap;

    #[test]
    fn sync_paths_reject_traversal_and_platform_special_names() {
        assert!(validate_relative_path("folder/report.pdf").is_ok());
        for invalid in [
            "../outside",
            "folder/../outside",
            "C:/secret",
            "folder\\file",
            "bad?.txt",
            "CON.txt",
            "folder/LPT1",
        ] {
            assert!(validate_relative_path(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn remote_conflict_name_is_stable_and_in_same_parent() {
        let root = std::env::temp_dir().to_string_lossy().into_owned();
        let result = unique_conflict_path(
            &root,
            "docs/report.pdf",
            "12345678-aaaa-bbbb-cccc-123456789abc",
        )
        .unwrap();
        assert!(result.starts_with("docs/report (CloudFusion conflict 12345678)"));
        assert!(validate_relative_path(&result).is_ok());
    }

    #[test]
    fn manifest_round_trips_remote_baselines() {
        let file = SyncedFile {
            remote_path: "report.txt".into(),
            node_id: "node".into(),
            version_id: "version".into(),
            checksum: "a".repeat(64),
            size: 12,
            version_number: 2,
            local_modified_ns: Some(123),
        };
        let manifest = SyncManifest {
            roots: BTreeMap::from([("root".into(), BTreeMap::from([("report.txt".into(), file)]))]),
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let restored: SyncManifest = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored.roots["root"]["report.txt"].size, 12);
    }
}
