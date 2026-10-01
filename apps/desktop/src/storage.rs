use futures::StreamExt;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const MANAGED_STORAGE_DIR: &str = ".cloudfusion/replicas";
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStorageRoot {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceReplicaEntry {
    #[serde(default)]
    node_id: String,
    #[serde(default)]
    version_id: String,
    relative_path: String,
    checksum: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStorageReplicaWorkItem {
    pub assignment_id: String,
    pub node_id: String,
    pub version_id: String,
    pub content_hash: String,
    pub size_bytes: String,
    pub attempts: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStorageReplicaReceipt {
    pub assignment_id: String,
    pub node_id: String,
    pub version_id: String,
    pub content_hash: String,
    pub size_bytes: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceReplicaManifest {
    entries: Vec<DeviceReplicaEntry>,
}

pub struct DeviceStorageState {
    config_file: PathBuf,
    root: Mutex<Option<DeviceStorageRoot>>,
}

impl DeviceStorageState {
    pub fn load(data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let storage_dir = data_dir.join("device-storage");
        fs::create_dir_all(&storage_dir)?;
        let config_file = storage_dir.join("root.json");
        let root = match fs::read(&config_file) {
            Ok(data) => Some(serde_json::from_slice::<DeviceStorageRoot>(&data)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(Box::new(error)),
        };
        Ok(Self {
            config_file,
            root: Mutex::new(root),
        })
    }

    fn save_root(&self, root: &DeviceStorageRoot) -> Result<(), String> {
        let bytes = serde_json::to_vec(root)
            .map_err(|_| "Could not encode device storage settings".to_owned())?;
        let parent = self
            .config_file
            .parent()
            .ok_or_else(|| "Could not resolve device storage settings directory".to_owned())?;
        let temporary = parent.join(format!(".root-{}.tmp", Uuid::new_v4().simple()));
        let result = (|| -> io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &self.config_file)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("Could not securely save device storage settings".to_owned());
        }
        Ok(())
    }

    pub(crate) fn configured_root_path(&self) -> Result<Option<String>, String> {
        self.root
            .lock()
            .map(|root| root.as_ref().map(|value| value.path.clone()))
            .map_err(|_| "Device storage settings are unavailable".to_owned())
    }

    pub(crate) fn ensure_separate_sync_path(&self, path: &Path) -> Result<(), String> {
        let root = self
            .root
            .lock()
            .map_err(|_| "Device storage settings are unavailable".to_owned())?;
        if root
            .as_ref()
            .is_some_and(|root| paths_overlap(path, Path::new(&root.path)))
        {
            return Err(
                "La carpeta sincronizada debe estar separada de la carpeta dedicada para réplicas"
                    .to_owned(),
            );
        }
        Ok(())
    }
}

pub(crate) fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = normalized_path(left);
    let right = normalized_path(right);
    left == right || left.starts_with(&right) || right.starts_with(&left)
}

fn normalized_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

fn replica_directory(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root);
    let metadata = fs::symlink_metadata(&root)
        .map_err(|_| "La carpeta dedicada de almacenamiento no está disponible".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("La carpeta dedicada de almacenamiento no es un directorio seguro".to_owned());
    }
    let metadata_dir = root.join(".cloudfusion");
    let replicas_dir = root.join(MANAGED_STORAGE_DIR);
    for directory in [&metadata_dir, &replicas_dir] {
        match fs::symlink_metadata(directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("La carpeta interna de réplicas no es segura".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(replicas_dir.clone());
            }
            Err(_) => return Err("No se pudo inspeccionar la carpeta de réplicas".to_owned()),
        }
    }
    Ok(replicas_dir)
}

fn prepare_replica_directory(root: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| "La carpeta dedicada de almacenamiento no está disponible".to_owned())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("La carpeta dedicada de almacenamiento no es un directorio seguro".to_owned());
    }
    let metadata_dir = root.join(".cloudfusion");
    match fs::symlink_metadata(&metadata_dir) {
        Ok(value) if value.file_type().is_symlink() || !value.is_dir() => {
            return Err("La carpeta interna de CloudFusion no es segura".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&metadata_dir)
                .map_err(|_| "No se pudo preparar la carpeta interna de CloudFusion".to_owned())?;
        }
        Err(_) => {
            return Err("No se pudo inspeccionar la carpeta interna de CloudFusion".to_owned())
        }
    }
    let replicas_dir = metadata_dir.join("replicas");
    match fs::symlink_metadata(&replicas_dir) {
        Ok(value) if value.file_type().is_symlink() || !value.is_dir() => {
            return Err("La carpeta interna de réplicas no es segura".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&replicas_dir)
                .map_err(|_| "No se pudo preparar la carpeta local de réplicas".to_owned())?;
        }
        Err(_) => return Err("No se pudo inspeccionar la carpeta local de réplicas".to_owned()),
    }
    Ok(replicas_dir)
}

fn storage_usage(root: &str) -> Result<u64, String> {
    let manifest_path = replica_directory(root)?.join("manifest.json");
    match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("El índice local de réplicas no es un archivo seguro".to_owned());
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("No se pudo inspeccionar el índice local de réplicas".to_owned()),
    }
    let manifest = read_manifest(&manifest_path)?;
    let replica_root = manifest_path
        .parent()
        .ok_or_else(|| "No se pudo resolver la carpeta de réplicas".to_owned())?;
    let mut total = 0u64;
    for entry in manifest.entries {
        if !valid_entry(&entry) {
            continue;
        }
        let path = replica_root.join(&entry.relative_path);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => metadata,
            _ => continue,
        };
        if metadata.len() != entry.size_bytes {
            continue;
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| "El uso de almacenamiento superó el límite de bytes".to_owned())?;
    }
    Ok(total)
}

fn read_manifest(path: &Path) -> Result<DeviceReplicaManifest, String> {
    let bytes =
        fs::read(path).map_err(|_| "No se pudo leer el índice local de réplicas".to_owned())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("El índice local de réplicas supera el límite permitido".to_owned());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "El índice local de réplicas no es válido".to_owned())
}

fn save_manifest(path: &Path, manifest: &DeviceReplicaManifest) -> Result<(), String> {
    let bytes = serde_json::to_vec(manifest)
        .map_err(|_| "Could not encode device replica manifest".to_owned())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Device replica manifest exceeds its safe size limit".to_owned());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Device replica manifest is not a safe regular file".to_owned());
        }
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve device replica manifest folder".to_owned())?;
    let temporary = parent.join(format!(".manifest-{}.tmp", Uuid::new_v4().simple()));
    let result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            let backup = parent.join(format!(".manifest-{}.bak", Uuid::new_v4().simple()));
            match fs::symlink_metadata(path) {
                Ok(_) => {
                    fs::rename(path, &backup)?;
                    if let Err(error) = fs::rename(&temporary, path) {
                        let _ = fs::rename(&backup, path);
                        return Err(error);
                    }
                    fs::remove_file(backup)?;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    fs::rename(&temporary, path)?;
                }
                Err(error) => return Err(error),
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("Could not securely save device replica manifest".to_owned());
    }
    Ok(())
}

pub(crate) fn build_local_file_index(
    root: &str,
) -> Result<HashMap<(String, u64), PathBuf>, String> {
    let manifest_path = replica_directory(root)?.join("manifest.json");
    let manifest = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
            read_manifest(&manifest_path)?
        }
        Ok(_) => return Err("Device replica manifest is not a safe regular file".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(_) => return Err("Could not inspect device replica manifest".to_owned()),
    };
    let replica_root = manifest_path
        .parent()
        .ok_or_else(|| "Could not resolve device replica folder".to_owned())?;
    let mut index = HashMap::new();
    for entry in manifest.entries {
        if !valid_entry(&entry) {
            continue;
        }
        let path = replica_root.join(&entry.relative_path);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => metadata,
            _ => continue,
        };
        if metadata.len() == entry.size_bytes {
            index.insert(
                (entry.checksum.to_ascii_lowercase(), entry.size_bytes),
                path,
            );
        }
    }
    Ok(index)
}

fn valid_entry(entry: &DeviceReplicaEntry) -> bool {
    !entry.relative_path.is_empty()
        && !Path::new(&entry.relative_path).is_absolute()
        && !entry
            .relative_path
            .chars()
            .any(|character| matches!(character, '/' | '\\' | ':'))
        && entry.relative_path != "."
        && entry.relative_path != ".."
        && Uuid::parse_str(&entry.node_id).is_ok()
        && Uuid::parse_str(&entry.version_id).is_ok()
        && entry.checksum.len() == 64
        && entry.checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn replica_file_name(node_id: &str, version_id: &str) -> Result<String, String> {
    Uuid::parse_str(node_id).map_err(|_| "The assigned file ID is invalid".to_owned())?;
    Uuid::parse_str(version_id).map_err(|_| "The assigned version ID is invalid".to_owned())?;
    Ok(format!("{node_id}-{version_id}.blob"))
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|_| "Could not inspect existing device replica".to_owned())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Could not verify existing device replica".to_owned())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex_bytes(&hasher.finalize()))
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

struct PreparedReplica {
    replica_dir: PathBuf,
    staging_path: PathBuf,
    final_path: PathBuf,
    receipt: DeviceStorageReplicaReceipt,
    reused: bool,
}

fn prepare_replica_download(
    root: &str,
    assignment: &DeviceStorageReplicaWorkItem,
    max_bytes: u64,
) -> Result<PreparedReplica, String> {
    let size_bytes = assignment
        .size_bytes
        .parse::<u64>()
        .map_err(|_| "Assigned file size is invalid".to_owned())?;
    if assignment.content_hash.len() != 64
        || !assignment
            .content_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Assigned file checksum is invalid".to_owned());
    }
    Uuid::parse_str(&assignment.assignment_id)
        .map_err(|_| "Device storage assignment ID is invalid".to_owned())?;
    let name = replica_file_name(&assignment.node_id, &assignment.version_id)?;
    let replica_dir = prepare_replica_directory(Path::new(root))?;
    let final_path = replica_dir.join(&name);
    let manifest_path = replica_dir.join("manifest.json");
    let mut manifest = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
            read_manifest(&manifest_path)?
        }
        Ok(_) => return Err("Device replica manifest is not a safe regular file".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => DeviceReplicaManifest::default(),
        Err(_) => return Err("Could not inspect device replica manifest".to_owned()),
    };
    if let Ok(metadata) = fs::symlink_metadata(&final_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("The managed replica destination is not a safe file".to_owned());
        }
        if metadata.len() == size_bytes
            && hash_file(&final_path)?.eq_ignore_ascii_case(&assignment.content_hash)
        {
            upsert_manifest_entry(&mut manifest, assignment, size_bytes, name);
            save_manifest(&manifest_path, &manifest)?;
            return Ok(PreparedReplica {
                replica_dir,
                staging_path: PathBuf::new(),
                final_path,
                receipt: receipt_for(assignment, size_bytes),
                reused: true,
            });
        }
        fs::remove_file(&final_path)
            .map_err(|_| "Could not replace the corrupted managed replica".to_owned())?;
        manifest.entries.retain(|entry| {
            entry.node_id != assignment.node_id || entry.version_id != assignment.version_id
        });
        save_manifest(&manifest_path, &manifest)?;
    }
    let used = storage_usage(root)?;
    if used
        .checked_add(size_bytes)
        .is_none_or(|total| total > max_bytes)
    {
        return Err(
            "This device's configured storage capacity is not sufficient for the assigned replica"
                .to_owned(),
        );
    }
    let staging_path = replica_dir.join(format!(".{}.part", assignment.assignment_id));
    match fs::symlink_metadata(&staging_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("The temporary device replica path is not a safe file".to_owned());
        }
        Ok(_) => fs::remove_file(&staging_path)
            .map_err(|_| "Could not replace the old temporary replica".to_owned())?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("Could not inspect the temporary device replica path".to_owned()),
    }
    Ok(PreparedReplica {
        replica_dir,
        staging_path,
        final_path,
        receipt: receipt_for(assignment, size_bytes),
        reused: false,
    })
}

fn upsert_manifest_entry(
    manifest: &mut DeviceReplicaManifest,
    assignment: &DeviceStorageReplicaWorkItem,
    size_bytes: u64,
    relative_path: String,
) {
    manifest.entries.retain(|entry| {
        entry.node_id != assignment.node_id || entry.version_id != assignment.version_id
    });
    manifest.entries.push(DeviceReplicaEntry {
        node_id: assignment.node_id.clone(),
        version_id: assignment.version_id.clone(),
        relative_path,
        checksum: assignment.content_hash.to_ascii_lowercase(),
        size_bytes,
    });
}

fn receipt_for(
    assignment: &DeviceStorageReplicaWorkItem,
    size_bytes: u64,
) -> DeviceStorageReplicaReceipt {
    DeviceStorageReplicaReceipt {
        assignment_id: assignment.assignment_id.clone(),
        node_id: assignment.node_id.clone(),
        version_id: assignment.version_id.clone(),
        content_hash: assignment.content_hash.to_ascii_lowercase(),
        size_bytes: size_bytes.to_string(),
    }
}

#[tauri::command]
pub fn get_device_storage_root(
    state: State<'_, DeviceStorageState>,
) -> Result<Option<DeviceStorageRoot>, String> {
    state
        .root
        .lock()
        .map(|root| root.clone())
        .map_err(|_| "Device storage settings are unavailable".to_owned())
}

#[tauri::command]
pub async fn choose_device_storage_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a dedicated CloudFusion storage folder")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_device_storage_root(
    path: String,
    sync_state: State<'_, crate::sync::SyncState>,
    state: State<'_, DeviceStorageState>,
) -> Result<DeviceStorageRoot, String> {
    let selected_path = PathBuf::from(&path);
    let selected_metadata = fs::symlink_metadata(&selected_path).map_err(|_| {
        "Selecciona una carpeta existente para el almacenamiento dedicado".to_owned()
    })?;
    if selected_metadata.file_type().is_symlink() || !selected_metadata.is_dir() {
        return Err("La carpeta de almacenamiento debe ser un directorio real y seguro".to_owned());
    }
    let canonical_path = fs::canonicalize(&selected_path)
        .map_err(|_| "No se pudo resolver la carpeta de almacenamiento".to_owned())?;
    sync_state.ensure_separate_storage_path(&canonical_path)?;
    if let Some(current) = state
        .root
        .lock()
        .map_err(|_| "Device storage settings are unavailable".to_owned())?
        .as_ref()
    {
        if !paths_overlap(Path::new(&current.path), &canonical_path)
            && storage_usage(&current.path)? > 0
        {
            return Err("Este dispositivo ya conserva réplicas en su carpeta dedicada. Descarga una copia de seguridad antes de cambiarla".to_owned());
        }
    }
    prepare_replica_directory(&canonical_path)?;
    let root = DeviceStorageRoot {
        path: canonical_path.to_string_lossy().into_owned(),
    };
    state.save_root(&root)?;
    *state
        .root
        .lock()
        .map_err(|_| "Device storage settings are unavailable".to_owned())? = Some(root.clone());
    Ok(root)
}

#[tauri::command]
pub async fn get_device_storage_usage(
    state: State<'_, DeviceStorageState>,
) -> Result<String, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Device storage settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Configura una carpeta local dedicada para réplicas".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || {
        storage_usage(&root.path).map(|bytes| bytes.to_string())
    })
    .await
    .map_err(|_| "Could not measure device storage usage".to_owned())?
}

#[tauri::command]
pub async fn index_device_storage_files(
    state: State<'_, DeviceStorageState>,
    sync_state: State<'_, crate::sync::SyncState>,
) -> Result<usize, String> {
    let root = state
        .root
        .lock()
        .map_err(|_| "Device storage settings are unavailable".to_owned())?
        .clone();
    let Some(root) = root else { return Ok(0) };
    let index = sync_state.shared_local_file_index();
    tauri::async_runtime::spawn_blocking(move || {
        let files = build_local_file_index(&root.path)?;
        let count = files.len();
        let mut shared = index
            .write()
            .map_err(|_| "The local file index is unavailable".to_owned())?;
        shared.extend(files);
        Ok(count)
    })
    .await
    .map_err(|_| "Could not index device replica files".to_owned())?
}

#[tauri::command]
pub async fn store_device_replica(
    api_url: String,
    access_token: String,
    max_bytes: String,
    assignment: DeviceStorageReplicaWorkItem,
    state: State<'_, DeviceStorageState>,
    sync_state: State<'_, crate::sync::SyncState>,
) -> Result<DeviceStorageReplicaReceipt, String> {
    if access_token.trim().is_empty() || access_token.len() > 16_384 {
        return Err("The CloudFusion session token is invalid".to_owned());
    }
    let api_url = validate_api_url(&api_url)?;
    let max_bytes = max_bytes
        .parse::<u64>()
        .map_err(|_| "The configured device storage capacity is invalid".to_owned())?;
    let root = state
        .root
        .lock()
        .map_err(|_| "Device storage settings are unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "Configure a dedicated local replica folder first".to_owned())?;
    let prepare_root = root.path.clone();
    let prepare_assignment = assignment.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_replica_download(&prepare_root, &prepare_assignment, max_bytes)
    })
    .await
    .map_err(|_| "Could not prepare local replica storage".to_owned())??;
    if prepared.reused {
        sync_state.insert_local_file(
            prepared.receipt.content_hash.clone(),
            prepared.receipt.size_bytes.parse().unwrap_or_default(),
            prepared.final_path,
        )?;
        return Ok(prepared.receipt);
    }

    let endpoint = format!(
        "{api_url}/virtual-drive/nodes/{}/versions/{}/download",
        assignment.node_id, assignment.version_id,
    );
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not initialize the CloudFusion replica download client".to_owned())?;
    let response = client
        .get(endpoint)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|_| {
            "Could not connect to CloudFusion to download the assigned replica".to_owned()
        })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => "The CloudFusion session expired; sign in again to store replicas".to_owned(),
            403 | 404 => "The assigned CloudFusion version is no longer accessible".to_owned(),
            status => {
                format!("CloudFusion could not download the assigned version (HTTP {status})")
            }
        });
    }
    let expected_size = assignment
        .size_bytes
        .parse::<u64>()
        .map_err(|_| "Assigned file size is invalid".to_owned())?;
    if response
        .content_length()
        .is_some_and(|length| length != expected_size)
    {
        return Err("CloudFusion announced an unexpected replica size".to_owned());
    }

    let staging_path = prepared.staging_path.clone();
    let download = async {
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)
            .await
            .map_err(|_| "Could not create the temporary device replica file".to_owned())?;
        let mut stream = response.bytes_stream();
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk =
                chunk.map_err(|_| "CloudFusion replica download was interrupted".to_owned())?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| "Assigned replica size overflowed".to_owned())?;
            if received > expected_size {
                return Err("CloudFusion sent more bytes than the assigned version size".to_owned());
            }
            hasher.update(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|_| "Could not write the downloaded device replica".to_owned())?;
        }
        output
            .flush()
            .await
            .map_err(|_| "Could not finish writing the device replica".to_owned())?;
        output
            .sync_data()
            .await
            .map_err(|_| "Could not persist the device replica".to_owned())?;
        drop(output);
        let actual_hash = hex_bytes(&hasher.finalize());
        if received != expected_size || !actual_hash.eq_ignore_ascii_case(&assignment.content_hash)
        {
            return Err(
                "The downloaded replica does not match its assigned size and SHA-256".to_owned(),
            );
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = download {
        let _ = tokio::fs::remove_file(&prepared.staging_path).await;
        return Err(error);
    }

    fs::rename(&prepared.staging_path, &prepared.final_path)
        .map_err(|_| "Could not atomically install the verified device replica".to_owned())?;
    let manifest_path = prepared.replica_dir.join("manifest.json");
    let mut manifest = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) if !metadata.file_type().is_symlink() && metadata.is_file() => {
            read_manifest(&manifest_path)?
        }
        Ok(_) => return Err("Device replica manifest is not a safe regular file".to_owned()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => DeviceReplicaManifest::default(),
        Err(_) => return Err("Could not inspect device replica manifest".to_owned()),
    };
    upsert_manifest_entry(
        &mut manifest,
        &assignment,
        expected_size,
        prepared
            .final_path
            .file_name()
            .ok_or_else(|| "Could not resolve replica filename".to_owned())?
            .to_string_lossy()
            .into_owned(),
    );
    save_manifest(&manifest_path, &manifest)?;
    sync_state.insert_local_file(
        prepared.receipt.content_hash.clone(),
        expected_size,
        prepared.final_path,
    )?;
    Ok(prepared.receipt)
}

fn validate_api_url(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value.trim().trim_end_matches('/'))
        .map_err(|_| "The CloudFusion API URL is invalid".to_owned())?;
    let local_http = parsed.scheme() == "http"
        && matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if parsed.host_str().is_none()
        || (parsed.scheme() != "https" && !local_http)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Use HTTPS for a remote CloudFusion API; plain HTTP is allowed only on localhost"
                .to_owned(),
        );
    }
    Ok(parsed.as_str().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        paths_overlap, prepare_replica_download, storage_usage, DeviceReplicaManifest,
        DeviceStorageReplicaWorkItem,
    };
    use std::fs;
    use uuid::Uuid;

    #[test]
    fn dedicated_storage_and_sync_roots_must_not_overlap() {
        let base = std::env::temp_dir().join(format!("cloudfusion-roots-{}", Uuid::new_v4()));
        let sync = base.join("sync");
        let storage = base.join("storage");
        assert!(paths_overlap(&sync, &sync));
        assert!(paths_overlap(&sync, &sync.join("nested")));
        assert!(paths_overlap(&sync.join("nested"), &sync));
        assert!(!paths_overlap(&sync, &storage));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn storage_usage_counts_only_manifested_regular_files_with_expected_sizes() {
        let root = std::env::temp_dir().join(format!("cloudfusion-replicas-{}", Uuid::new_v4()));
        let replica_root = root.join(".cloudfusion/replicas");
        fs::create_dir_all(&replica_root).unwrap();
        fs::write(replica_root.join("known.blob"), b"abc").unwrap();
        fs::write(replica_root.join("unknown.blob"), b"not counted").unwrap();
        let manifest = DeviceReplicaManifest {
            entries: vec![
                super::DeviceReplicaEntry {
                    node_id: Uuid::new_v4().to_string(),
                    version_id: Uuid::new_v4().to_string(),
                    relative_path: "known.blob".into(),
                    checksum: "a".repeat(64),
                    size_bytes: 3,
                },
                super::DeviceReplicaEntry {
                    node_id: Uuid::new_v4().to_string(),
                    version_id: Uuid::new_v4().to_string(),
                    relative_path: "unknown.blob".into(),
                    checksum: "b".repeat(64),
                    size_bytes: 1,
                },
                super::DeviceReplicaEntry {
                    node_id: Uuid::new_v4().to_string(),
                    version_id: Uuid::new_v4().to_string(),
                    relative_path: "../escape".into(),
                    checksum: "c".repeat(64),
                    size_bytes: 100,
                },
            ],
        };
        fs::write(
            replica_root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        assert_eq!(storage_usage(root.to_str().unwrap()).unwrap(), 3);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn storage_usage_requires_the_dedicated_root_to_be_available() {
        let missing = std::env::temp_dir().join(format!("cloudfusion-missing-{}", Uuid::new_v4()));
        assert!(storage_usage(missing.to_str().unwrap()).is_err());
    }

    #[test]
    fn assigned_replica_is_reused_only_after_sha256_verification() {
        let root =
            std::env::temp_dir().join(format!("cloudfusion-replica-install-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let assignment = DeviceStorageReplicaWorkItem {
            assignment_id: Uuid::new_v4().to_string(),
            node_id: Uuid::new_v4().to_string(),
            version_id: Uuid::new_v4().to_string(),
            content_hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into(),
            size_bytes: "3".into(),
            attempts: 1,
        };

        let pending = prepare_replica_download(root.to_str().unwrap(), &assignment, 3).unwrap();
        assert!(!pending.reused);
        fs::write(&pending.staging_path, b"abc").unwrap();
        fs::rename(&pending.staging_path, &pending.final_path).unwrap();

        let verified = prepare_replica_download(root.to_str().unwrap(), &assignment, 3).unwrap();
        assert!(verified.reused);
        assert_eq!(storage_usage(root.to_str().unwrap()).unwrap(), 3);
        fs::remove_dir_all(root).unwrap();
    }
}
