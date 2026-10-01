use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures::StreamExt;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const MAX_PENDING_CHANGES: usize = 500;
const MAX_INDEXED_FILES: usize = 50_000;
const HASH_BUFFER_BYTES: usize = 128 * 1024;

pub type LocalFileIndex = HashMap<(String, u64), PathBuf>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRoot {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub remote_node_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncedFileState {
    remote_path: String,
    version_id: String,
    #[serde(default)]
    checksum: Option<String>,
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    version_number: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncManifest {
    roots: HashMap<String, HashMap<String, SyncedFileState>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncUploadReceipt {
    pub root_id: String,
    pub relative_path: String,
    pub remote_path: String,
    pub node_id: String,
    pub version_id: String,
    pub content_hash: String,
    pub size_bytes: String,
    pub conflict: bool,
    pub unchanged: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiEnvelope<T> {
    data: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncUploadResponse {
    node: SyncUploadedNode,
    version: Option<SyncUploadedVersion>,
    conflict: bool,
    #[serde(default)]
    unchanged: bool,
    #[serde(default)]
    replicas: usize,
    warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncUploadedNode {
    id: String,
    name: String,
    current_version_id: Option<String>,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncUploadedVersion {
    id: String,
    checksum: String,
    size: u64,
    #[serde(default)]
    version_number: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncManifestEntry {
    pub relative_path: String,
    pub remote_path: String,
    pub version_id: String,
    pub checksum: Option<String>,
    pub size_bytes: Option<u64>,
    pub version_number: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSyncReceipt {
    pub status: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncChange {
    pub id: String,
    pub root_id: String,
    pub relative_path: String,
    pub operation: String,
    pub detected_at_ms: u128,
}

pub struct SyncState {
    app: AppHandle,
    roots_file: PathBuf,
    journal_file: Arc<PathBuf>,
    manifest_file: PathBuf,
    roots: Mutex<Vec<SyncRoot>>,
    manifest: Mutex<SyncManifest>,
    local_file_index: Arc<RwLock<LocalFileIndex>>,
    pending: Arc<Mutex<VecDeque<SyncChange>>>,
    journal_lock: Arc<Mutex<()>>,
    remote_write_hashes: Arc<Mutex<HashMap<PathBuf, String>>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl SyncState {
    pub fn load(app: AppHandle, data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let sync_dir = data_dir.join("sync");
        fs::create_dir_all(&sync_dir)?;
        let roots_file = sync_dir.join("roots.json");
        let journal_file = sync_dir.join("changes.jsonl");
        let manifest_file = sync_dir.join("manifest.json");
        let roots = match fs::read(&roots_file) {
            Ok(data) => serde_json::from_slice::<Vec<SyncRoot>>(&data)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(Box::new(error)),
        };
        let manifest = match fs::read(&manifest_file) {
            Ok(data) => serde_json::from_slice::<SyncManifest>(&data)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SyncManifest::default(),
            Err(error) => return Err(Box::new(error)),
        };
        let pending = Arc::new(Mutex::new(load_recent_changes(&journal_file)?));
        let journal_lock = Arc::new(Mutex::new(()));
        let state = Self {
            app,
            roots_file,
            journal_file: Arc::new(journal_file),
            manifest_file,
            roots: Mutex::new(roots.clone()),
            manifest: Mutex::new(manifest),
            local_file_index: Arc::new(RwLock::new(HashMap::new())),
            pending,
            journal_lock,
            remote_write_hashes: Arc::new(Mutex::new(HashMap::new())),
            watchers: Mutex::new(HashMap::new()),
        };

        for root in roots {
            if Path::new(&root.path).is_dir() {
                if let Err(error) = state.attach_watcher(&root) {
                    eprintln!("Could not resume local sync watcher: {error}");
                }
            }
        }
        Ok(state)
    }

    fn attach_watcher(&self, root: &SyncRoot) -> Result<(), String> {
        let root_path = PathBuf::from(&root.path);
        let root_id = root.id.clone();
        let app = self.app.clone();
        let pending = Arc::clone(&self.pending);
        let local_file_index = Arc::clone(&self.local_file_index);
        let journal_lock = Arc::clone(&self.journal_lock);
        let journal_file = Arc::clone(&self.journal_file);
        let remote_write_hashes = Arc::clone(&self.remote_write_hashes);
        let event_root_path = root_path.clone();

        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else { return };
            if let Ok(mut index) = local_file_index.write() {
                index.clear();
            }
            let operation = match event.kind {
                EventKind::Create(_) => "created",
                EventKind::Modify(_) => "modified",
                EventKind::Remove(_) => "deleted",
                EventKind::Any | EventKind::Other => "changed",
                EventKind::Access(_) => return,
            };

            for changed_path in event.paths {
                let Ok(relative_path) = changed_path.strip_prefix(&event_root_path) else {
                    continue;
                };
                if relative_path.as_os_str().is_empty() {
                    continue;
                }
                if is_internal_sync_path(relative_path) {
                    continue;
                }
                let is_file = fs::symlink_metadata(&changed_path)
                    .map(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
                    .unwrap_or(operation == "deleted");
                if !is_file {
                    continue;
                }
                let watch_path =
                    fs::canonicalize(&changed_path).unwrap_or_else(|_| changed_path.clone());
                if let Ok(mut writes) = remote_write_hashes.lock() {
                    if let Some(expected_hash) = writes.get(&watch_path).cloned() {
                        if operation == "deleted" {
                            continue;
                        }
                        if hash_file(&changed_path)
                            .map(|actual| actual.eq_ignore_ascii_case(&expected_hash))
                            .unwrap_or(false)
                        {
                            writes.remove(&watch_path);
                            continue;
                        }
                        writes.remove(&watch_path);
                    }
                }
                let change = SyncChange {
                    id: Uuid::new_v4().to_string(),
                    root_id: root_id.clone(),
                    relative_path: relative_path.to_string_lossy().replace('\\', "/"),
                    operation: operation.to_owned(),
                    detected_at_ms: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|duration| duration.as_millis())
                        .unwrap_or_default(),
                };
                record_change(&app, &pending, &journal_lock, &journal_file, change);
            }
        })
        .map_err(|error| error.to_string())?;

        watcher
            .watch(&root_path, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        self.watchers
            .lock()
            .map_err(|_| "Sync watcher state is unavailable".to_owned())?
            .insert(root.id.clone(), watcher);
        Ok(())
    }

    fn save_roots(&self, roots: &[SyncRoot]) -> Result<(), String> {
        let data = serde_json::to_vec_pretty(roots).map_err(|error| error.to_string())?;
        fs::write(&self.roots_file, data).map_err(|error| error.to_string())
    }

    fn save_manifest(&self, manifest: &SyncManifest) -> Result<(), String> {
        let data = serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
        fs::write(&self.manifest_file, data).map_err(|error| error.to_string())
    }

    fn get_root(&self, id: &str) -> Result<SyncRoot, String> {
        self.roots
            .lock()
            .map_err(|_| "Sync root state is unavailable".to_owned())?
            .iter()
            .find(|root| root.id == id)
            .cloned()
            .ok_or_else(|| "Sync folder not found".to_owned())
    }

    fn get_file_state(
        &self,
        root_id: &str,
        relative_path: &str,
    ) -> Result<Option<SyncedFileState>, String> {
        self.manifest
            .lock()
            .map_err(|_| "Sync manifest is unavailable".to_owned())
            .map(|manifest| {
                manifest
                    .roots
                    .get(root_id)
                    .and_then(|files| files.get(relative_path))
                    .cloned()
            })
    }

    fn get_manifest_entries(&self, root_id: &str) -> Result<Vec<SyncManifestEntry>, String> {
        self.manifest
            .lock()
            .map_err(|_| "Sync manifest is unavailable".to_owned())
            .map(|manifest| {
                manifest
                    .roots
                    .get(root_id)
                    .into_iter()
                    .flat_map(|files| files.iter())
                    .map(|(relative_path, file)| SyncManifestEntry {
                        relative_path: relative_path.clone(),
                        remote_path: file.remote_path.clone(),
                        version_id: file.version_id.clone(),
                        checksum: file.checksum.clone(),
                        size_bytes: file.size_bytes,
                        version_number: file.version_number,
                    })
                    .collect()
            })
    }

    fn staging_path(
        &self,
        root: &SyncRoot,
        remote_path: &str,
        version_id: &str,
    ) -> Result<PathBuf, String> {
        let (_, target) = resolve_sync_target(&root.path, remote_path, true)?;
        let digest =
            Sha256::digest(format!("{}\0{}\0{}", root.id, remote_path, version_id).as_bytes());
        let name = format!(".cloudfusion-sync-{}.download", hex_bytes(&digest[..16]));
        let path = target
            .parent()
            .ok_or_else(|| "La ruta sincronizada no tiene una carpeta válida".to_owned())?
            .join(name);
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err("El archivo temporal de sincronización no es seguro".to_owned());
            }
        }
        Ok(path)
    }

    fn install_remote_stage(
        &self,
        root_id: &str,
        remote_path: &str,
        node_id: &str,
        version_id: &str,
        checksum: &str,
        size_bytes: u64,
        version_number: u64,
        staging_path: &Path,
    ) -> Result<RemoteSyncReceipt, String> {
        Uuid::parse_str(root_id)
            .map_err(|_| "El identificador de la carpeta local no es v\u{00e1}lido".to_owned())?;
        Uuid::parse_str(node_id)
            .map_err(|_| "El identificador del archivo remoto no es v\u{00e1}lido".to_owned())?;
        Uuid::parse_str(version_id).map_err(|_| {
            "El identificador de versi\u{00f3}n remota no es v\u{00e1}lido".to_owned()
        })?;
        validate_relative_path(remote_path)?;
        validate_checksum(checksum)?;
        let root = self.get_root(root_id)?;
        if root.remote_node_id.is_none() {
            return Err(
                "La carpeta local ya no est\u{00e1} vinculada a CloudFusion Drive".to_owned(),
            );
        }
        let expected_staging = self.staging_path(&root, remote_path, version_id)?;
        if staging_path != expected_staging {
            return Err("La ruta temporal no corresponde a esta sincronizaci\u{00f3}n".to_owned());
        }
        if self.has_pending_remote_change(root_id, remote_path)? {
            return Ok(RemoteSyncReceipt {
                status: "deferred".to_owned(),
                relative_path: remote_path.to_owned(),
            });
        }
        let staging_metadata = fs::symlink_metadata(staging_path)
            .map_err(|_| "No se encontr\u{00f3} la descarga temporal verificada".to_owned())?;
        if staging_metadata.file_type().is_symlink()
            || !staging_metadata.is_file()
            || staging_metadata.len() != size_bytes
        {
            return Err("El archivo temporal no coincide con el tama\u{00f1}o remoto".to_owned());
        }
        let staging_checksum = hash_file(staging_path)?;
        if !staging_checksum.eq_ignore_ascii_case(checksum) {
            let _ = fs::remove_file(staging_path);
            return Err(
                "La descarga remota no super\u{00f3} la verificaci\u{00f3}n SHA-256".to_owned(),
            );
        }

        let candidates = self
            .get_manifest_entries(root_id)?
            .into_iter()
            .filter(|entry| entry.remote_path == remote_path)
            .collect::<Vec<_>>();
        if candidates
            .iter()
            .any(|entry| entry.version_id == version_id)
        {
            let _ = fs::remove_file(staging_path);
            return Ok(RemoteSyncReceipt {
                status: "unchanged".to_owned(),
                relative_path: candidates
                    .iter()
                    .find(|entry| entry.version_id == version_id)
                    .map(|entry| entry.relative_path.clone())
                    .unwrap_or_else(|| remote_path.to_owned()),
            });
        }
        let latest = candidates
            .into_iter()
            .max_by_key(|entry| entry.version_number);
        let target_relative = latest
            .as_ref()
            .map(|entry| entry.relative_path.clone())
            .unwrap_or_else(|| remote_path.to_owned());
        let (_, target) = resolve_sync_target(&root.path, &target_relative, true)?;
        let target_metadata = fs::symlink_metadata(&target).ok();
        let target_checksum = if target_metadata.is_some() {
            Some(hash_file(&target)?)
        } else {
            None
        };
        if target_checksum
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(checksum))
        {
            self.save_remote_manifest_entry(
                root_id,
                &target_relative,
                remote_path,
                version_id,
                checksum,
                size_bytes,
                version_number,
            )?;
            let _ = fs::remove_file(staging_path);
            return Ok(RemoteSyncReceipt {
                status: "unchanged".to_owned(),
                relative_path: target_relative,
            });
        }

        let safe_to_replace = match (
            latest.as_ref(),
            target_checksum.as_deref(),
            target_metadata.as_ref(),
        ) {
            (Some(previous), Some(actual), Some(metadata)) => local_matches_manifest(
                previous.checksum.as_deref(),
                previous.size_bytes,
                actual,
                metadata.len(),
            ),
            _ => false,
        };
        let mut conflict = target_metadata.is_some() && !safe_to_replace;
        let mut install_relative = if conflict {
            conflict_relative_path(&target_relative, version_id)?
        } else {
            target_relative.clone()
        };
        let (_, mut install_target) = resolve_sync_target(&root.path, &install_relative, true)?;
        if conflict {
            if let Ok(metadata) = fs::symlink_metadata(&install_target) {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err("El nombre local de conflicto ya est\u{00e1} ocupado por un elemento no seguro".to_owned());
                }
                if metadata.len() == size_bytes
                    && hash_file(&install_target)?.eq_ignore_ascii_case(checksum)
                {
                    self.save_remote_manifest_entry(
                        root_id,
                        &install_relative,
                        remote_path,
                        version_id,
                        checksum,
                        size_bytes,
                        version_number,
                    )?;
                    let _ = fs::remove_file(staging_path);
                    return Ok(RemoteSyncReceipt {
                        status: "conflict".to_owned(),
                        relative_path: install_relative,
                    });
                }
                return Err(
                    "No se sobrescribi\u{00f3} un archivo que ya ocupaba el nombre de conflicto"
                        .to_owned(),
                );
            }
        }

        let backup_path = if safe_to_replace {
            let backup = target
                .parent()
                .ok_or_else(|| {
                    "La ruta sincronizada no tiene una carpeta v\u{00e1}lida".to_owned()
                })?
                .join(format!(
                    ".cloudfusion-sync-{}.backup",
                    Uuid::new_v4().simple()
                ));
            let watch_key = fs::canonicalize(&target).unwrap_or_else(|_| target.clone());
            self.remote_write_hashes
                .lock()
                .map_err(|_| {
                    "El estado de sincronizaci\u{00f3}n remota no est\u{00e1} disponible".to_owned()
                })?
                .insert(watch_key.clone(), checksum.to_ascii_lowercase());
            if let Err(error) = fs::rename(&target, &backup) {
                if let Ok(mut writes) = self.remote_write_hashes.lock() {
                    writes.remove(&watch_key);
                }
                return Err(error.to_string());
            }
            let backup_matches = fs::metadata(&backup).ok().is_some_and(|metadata| {
                latest.as_ref().and_then(|entry| entry.size_bytes) == Some(metadata.len())
                    && latest
                        .as_ref()
                        .and_then(|entry| entry.checksum.as_deref())
                        .is_some_and(|expected| {
                            hash_file(&backup)
                                .is_ok_and(|actual| actual.eq_ignore_ascii_case(expected))
                        })
            });
            if !backup_matches {
                let _ = fs::rename(&backup, &target);
                if let Ok(mut writes) = self.remote_write_hashes.lock() {
                    writes.remove(&watch_key);
                }
                conflict = true;
                install_relative = conflict_relative_path(&target_relative, version_id)?;
                let (_, safe_target) = resolve_sync_target(&root.path, &install_relative, true)?;
                install_target = safe_target;
                None
            } else {
                Some(backup)
            }
        } else {
            None
        };

        let watch_key =
            fs::canonicalize(&install_target).unwrap_or_else(|_| install_target.clone());
        self.remote_write_hashes
            .lock()
            .map_err(|_| {
                "El estado de sincronizaci\u{00f3}n remota no est\u{00e1} disponible".to_owned()
            })?
            .insert(watch_key.clone(), checksum.to_ascii_lowercase());
        if let Err(error) = fs::rename(staging_path, &install_target) {
            if let Some(backup) = backup_path.as_ref() {
                let _ = fs::rename(backup, &target);
            }
            if let Ok(mut writes) = self.remote_write_hashes.lock() {
                writes.remove(&watch_key);
            }
            return Err(error.to_string());
        }
        if let Some(backup) = backup_path {
            let _ = fs::remove_file(backup);
        }
        let _ = fs::remove_file(
            install_target
                .parent()
                .unwrap_or(&install_target)
                .join(format!(
                    ".cloudfusion-{}.partial",
                    checksum.to_ascii_lowercase()
                )),
        );
        self.save_remote_manifest_entry(
            root_id,
            &install_relative,
            remote_path,
            version_id,
            checksum,
            size_bytes,
            version_number,
        )?;
        if let Ok(mut index) = self.local_file_index.write() {
            index.insert((checksum.to_ascii_lowercase(), size_bytes), install_target);
        }
        Ok(RemoteSyncReceipt {
            status: if conflict { "conflict" } else { "installed" }.to_owned(),
            relative_path: install_relative,
        })
    }

    fn save_remote_manifest_entry(
        &self,
        root_id: &str,
        relative_path: &str,
        remote_path: &str,
        version_id: &str,
        checksum: &str,
        size_bytes: u64,
        version_number: u64,
    ) -> Result<(), String> {
        let mut manifest = self
            .manifest
            .lock()
            .map_err(|_| "Sync manifest is unavailable".to_owned())?;
        manifest
            .roots
            .entry(root_id.to_owned())
            .or_default()
            .insert(
                relative_path.to_owned(),
                SyncedFileState {
                    remote_path: remote_path.to_owned(),
                    version_id: version_id.to_owned(),
                    checksum: Some(checksum.to_ascii_lowercase()),
                    size_bytes: Some(size_bytes),
                    version_number,
                },
            );
        self.save_manifest(&manifest)
    }

    fn has_pending_remote_change(&self, root_id: &str, remote_path: &str) -> Result<bool, String> {
        let manifest = self.get_manifest_entries(root_id)?;
        let mut paths = manifest
            .iter()
            .filter(|entry| entry.remote_path == remote_path)
            .map(|entry| entry.relative_path.clone())
            .collect::<Vec<_>>();
        if paths.is_empty() {
            paths.push(remote_path.to_owned());
        }
        let pending = self
            .pending
            .lock()
            .map_err(|_| "Sync change queue is unavailable".to_owned())?;
        Ok(pending.iter().any(|change| {
            change.root_id == root_id && paths.iter().any(|path| path == &change.relative_path)
        }))
    }

    fn acknowledge_change(&self, id: &str) -> Result<bool, String> {
        let _journal_guard = self
            .journal_lock
            .lock()
            .map_err(|_| "Sync journal is unavailable".to_owned())?;
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Sync change queue is unavailable".to_owned())?;
        let previous = pending.clone();
        pending.retain(|change| change.id != id);
        if pending.len() == previous.len() {
            return Ok(false);
        }
        let contents = pending
            .iter()
            .filter_map(|item| serde_json::to_string(item).ok())
            .collect::<Vec<_>>()
            .join("\n");
        let contents = if contents.is_empty() {
            String::new()
        } else {
            contents + "\n"
        };
        if let Err(error) = fs::write(self.journal_file.as_ref().as_path(), contents) {
            *pending = previous;
            return Err(error.to_string());
        }
        Ok(true)
    }

    pub(crate) fn shared_local_file_index(&self) -> Arc<RwLock<LocalFileIndex>> {
        Arc::clone(&self.local_file_index)
    }
}

fn validate_relative_path(value: &str) -> Result<Vec<&str>, String> {
    if value.is_empty() || value.len() > 4096 || value.starts_with('/') || value.contains('\\') {
        return Err("La ruta relativa del archivo no es válida".to_owned());
    }
    let segments = value.split('/').collect::<Vec<_>>();
    if segments.len() > 128
        || segments.iter().any(|segment| {
            segment.is_empty()
                || segment.encode_utf16().count() > 255
                || segment.trim() != *segment
                || *segment == "."
                || *segment == ".."
                || segment.chars().any(|character| {
                    character.is_control()
                        || ['<', '>', ':', '"', '|', '?', '*'].contains(&character)
                })
        })
    {
        return Err("La ruta relativa del archivo no es válida".to_owned());
    }
    Ok(segments)
}

fn resolve_sync_file(root_path: &str, relative_path: &str) -> Result<PathBuf, String> {
    let segments = validate_relative_path(relative_path)?;
    let root = PathBuf::from(root_path);
    let root_metadata = fs::symlink_metadata(&root)
        .map_err(|_| "La carpeta sincronizada ya no está disponible".to_owned())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("La carpeta sincronizada no es un directorio local válido".to_owned());
    }
    let canonical_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    let mut current = canonical_root.clone();
    for segment in segments {
        current.push(segment);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "El archivo sincronizado ya no está disponible".to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err("No se sincronizan enlaces simbólicos".to_owned());
        }
        let canonical = fs::canonicalize(&current).map_err(|error| error.to_string())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("La ruta del archivo sale de la carpeta sincronizada".to_owned());
        }
        current = canonical;
    }
    if !fs::metadata(&current)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Solo se pueden sincronizar archivos regulares".to_owned());
    }
    Ok(current)
}

fn resolve_sync_target(
    root_path: &str,
    relative_path: &str,
    create_parent: bool,
) -> Result<(PathBuf, PathBuf), String> {
    let segments = validate_relative_path(relative_path)?;
    let root = PathBuf::from(root_path);
    let root_metadata = fs::symlink_metadata(&root)
        .map_err(|_| "La carpeta sincronizada ya no est\u{00e1} disponible".to_owned())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("La carpeta sincronizada no es un directorio local v\u{00e1}lido".to_owned());
    }
    let canonical_root = fs::canonicalize(&root).map_err(|error| error.to_string())?;
    let mut parent = canonical_root.clone();
    for segment in &segments[..segments.len() - 1] {
        parent.push(segment);
        match fs::symlink_metadata(&parent) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("La ruta sincronizada contiene una carpeta no segura".to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create_parent => {
                fs::create_dir(&parent).map_err(|create_error| create_error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        parent = fs::canonicalize(&parent).map_err(|error| error.to_string())?;
        if !parent.starts_with(&canonical_root) {
            return Err("La ruta del archivo sale de la carpeta sincronizada".to_owned());
        }
    }
    let target = parent.join(segments[segments.len() - 1]);
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("El destino local existe y no es un archivo regular seguro".to_owned());
        }
        let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
        if !canonical_target.starts_with(&canonical_root) {
            return Err("La ruta del archivo sale de la carpeta sincronizada".to_owned());
        }
        return Ok((canonical_root, canonical_target));
    }
    Ok((canonical_root, target))
}

fn is_internal_sync_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".cloudfusion-"))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn validate_checksum(checksum: &str) -> Result<(), String> {
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("La suma SHA-256 de la versi\u{00f3}n remota no es v\u{00e1}lida".to_owned());
    }
    Ok(())
}

fn local_matches_manifest(
    expected_checksum: Option<&str>,
    expected_size: Option<u64>,
    actual_checksum: &str,
    actual_size: u64,
) -> bool {
    expected_size == Some(actual_size)
        && expected_checksum.is_some_and(|expected| expected.eq_ignore_ascii_case(actual_checksum))
}

fn conflict_relative_path(relative_path: &str, version_id: &str) -> Result<String, String> {
    let (parent, file_name) = relative_path
        .rsplit_once('/')
        .map(|(parent, file_name)| (Some(parent), file_name))
        .unwrap_or((None, relative_path));
    let path = Path::new(file_name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let version_tag = version_id.replace('-', "");
    let marker = format!(
        " (CloudFusion conflict {})",
        &version_tag[..8.min(version_tag.len())]
    );
    let extension = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    let reserved = marker.encode_utf16().count() + extension.encode_utf16().count();
    if reserved >= 255 {
        return Err(
            "No se pudo generar un nombre local seguro para conservar el conflicto".to_owned(),
        );
    }
    let mut shortened_stem = String::new();
    for character in stem.chars() {
        if shortened_stem.encode_utf16().count() + character.len_utf16() + reserved > 255 {
            break;
        }
        shortened_stem.push(character);
    }
    if shortened_stem.is_empty() {
        shortened_stem.push_str("archivo");
    }
    let conflict_name = format!("{shortened_stem}{marker}{extension}");
    let result = parent.map_or_else(
        || conflict_name.clone(),
        |parent| format!("{parent}/{conflict_name}"),
    );
    validate_relative_path(&result)?;
    Ok(result)
}

fn sync_file_matches(
    root_path: &str,
    relative_path: &str,
    expected_hash: &str,
    expected_size: u64,
) -> bool {
    let Ok(path) = resolve_sync_file(root_path, relative_path) else {
        return false;
    };
    let Ok(metadata) = fs::metadata(&path) else {
        return false;
    };
    if metadata.len() != expected_size {
        return false;
    }
    hash_file(&path)
        .map(|hash| hash.eq_ignore_ascii_case(expected_hash))
        .unwrap_or(false)
}

fn storage_bytes_for_manifest(roots: &[SyncRoot], manifest: &SyncManifest) -> Result<u64, String> {
    if !roots.iter().any(|root| root.remote_node_id.is_some()) {
        return Err(
            "Storage contribution requires at least one configured CloudFusion sync folder"
                .to_owned(),
        );
    }
    let mut total = 0u64;
    for root in roots.iter().filter(|root| root.remote_node_id.is_some()) {
        let root_metadata = fs::symlink_metadata(&root.path)
            .map_err(|_| "A configured CloudFusion sync folder is unavailable".to_owned())?;
        if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
            return Err("A configured CloudFusion sync folder is not a safe directory".to_owned());
        }
        let Some(entries) = manifest.roots.get(&root.id) else {
            continue;
        };
        for (relative_path, entry) in entries {
            if entry.checksum.is_none() {
                continue;
            }
            let Some(expected_size) = entry.size_bytes else {
                continue;
            };
            let Ok(path) = resolve_sync_file(&root.path, relative_path) else {
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(path) else {
                continue;
            };
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != expected_size
            {
                continue;
            }
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| "CloudFusion-managed storage usage overflowed".to_owned())?;
        }
    }
    Ok(total)
}

fn collect_sync_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<String>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_sync_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
            let value = relative.to_string_lossy().replace('\\', "/");
            validate_relative_path(&value)?;
            files.push(value);
            if files.len() > MAX_INDEXED_FILES {
                return Err(format!("Una carpeta de sync contiene más de {MAX_INDEXED_FILES} archivos; reduce la selección y vuelve a intentar"));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn index_sync_files(state: State<'_, SyncState>) -> Result<usize, String> {
    let roots = state
        .roots
        .lock()
        .map_err(|_| "Sync root state is unavailable".to_owned())?
        .clone();
    let index = state.shared_local_file_index();
    tauri::async_runtime::spawn_blocking(move || {
        let indexed = build_local_file_index(&roots)?;
        let mut shared = index
            .write()
            .map_err(|_| "The local file index is unavailable".to_owned())?;
        let indexed_count = indexed.len();
        *shared = indexed.clone();
        Ok(indexed_count)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn has_indexed_file_version(
    content_hash: String,
    size_bytes: String,
    state: State<'_, SyncState>,
) -> Result<bool, String> {
    if content_hash.len() != 64 || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("File checksum is invalid".to_owned());
    }
    let size_bytes = size_bytes
        .parse::<u64>()
        .map_err(|_| "File size is invalid".to_owned())?;
    let index = state.shared_local_file_index();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(path) = resolve_indexed_file(&index, &content_hash, size_bytes) else {
            return Ok(false);
        };
        let actual_size = fs::metadata(&path)
            .map_err(|error| error.to_string())?
            .len();
        if actual_size != size_bytes {
            return Ok(false);
        }
        let actual_hash = hash_file(&path)?;
        Ok(actual_hash.eq_ignore_ascii_case(&content_hash))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn verify_sync_file_copy(
    root_id: String,
    relative_path: String,
    content_hash: String,
    size_bytes: String,
    state: State<'_, SyncState>,
) -> Result<bool, String> {
    Uuid::parse_str(&root_id).map_err(|_| "The sync folder identifier is invalid".to_owned())?;
    if content_hash.len() != 64 || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("File checksum is invalid".to_owned());
    }
    let size_bytes = size_bytes
        .parse::<u64>()
        .map_err(|_| "File size is invalid".to_owned())?;
    let root = state.get_root(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(sync_file_matches(
            &root.path,
            &relative_path,
            &content_hash,
            size_bytes,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn build_local_file_index(roots: &[SyncRoot]) -> Result<LocalFileIndex, String> {
    let mut index = HashMap::new();
    let mut visited = 0usize;
    for root in roots {
        let root_path = fs::canonicalize(&root.path).map_err(|error| error.to_string())?;
        if !root_path.is_dir() {
            continue;
        }
        index_directory(&root_path, &root_path, &mut index, &mut visited)?;
    }
    Ok(index)
}

fn index_directory(
    root: &Path,
    directory: &Path,
    index: &mut LocalFileIndex,
    visited: &mut usize,
) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let path = entry.path();
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            index_directory(root, &path, index, visited)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }

        *visited += 1;
        if *visited > MAX_INDEXED_FILES {
            return Err(format!("A sync folder contains more than {MAX_INDEXED_FILES} files; narrow the selected folders and retry"));
        }
        let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
        if !canonical.starts_with(root) {
            continue;
        }
        let size = fs::metadata(&canonical)
            .map_err(|error| error.to_string())?
            .len();
        let content_hash = hash_file(&canonical)?;
        index.entry((content_hash, size)).or_insert(canonical);
    }
    Ok(())
}

pub(crate) fn hash_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; HASH_BUFFER_BYTES];
    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn resolve_indexed_file(
    index: &RwLock<LocalFileIndex>,
    content_hash: &str,
    size_bytes: u64,
) -> Result<PathBuf, String> {
    index
        .read()
        .map_err(|_| "The local file index is unavailable".to_owned())?
        .get(&(content_hash.to_ascii_lowercase(), size_bytes))
        .cloned()
        .ok_or_else(|| "No indexed local copy matches this exact file version".to_owned())
}

fn record_change(
    app: &AppHandle,
    pending: &Mutex<VecDeque<SyncChange>>,
    journal_lock: &Mutex<()>,
    journal_file: &Path,
    change: SyncChange,
) {
    let Ok(_journal_guard) = journal_lock.lock() else {
        return;
    };
    let Ok(mut journal) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_file)
    else {
        return;
    };
    let Ok(json) = serde_json::to_vec(&change) else {
        return;
    };
    if journal.write_all(&json).is_err() || journal.write_all(b"\n").is_err() {
        return;
    }
    let compact = if let Ok(mut pending) = pending.lock() {
        pending.push_back(change.clone());
        let mut compact = false;
        while pending.len() > MAX_PENDING_CHANGES {
            pending.pop_front();
            compact = true;
        }
        compact
    } else {
        false
    };
    drop(journal);
    if compact {
        if let Ok(pending) = pending.lock() {
            let contents = pending
                .iter()
                .filter_map(|item| serde_json::to_string(item).ok())
                .collect::<Vec<_>>()
                .join("\n");
            let _ = fs::write(journal_file, contents + "\n");
        }
    }
    let _ = app.emit("sync-change", change);
}

fn load_recent_changes(path: &Path) -> Result<VecDeque<SyncChange>, Box<dyn std::error::Error>> {
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(VecDeque::new()),
        Err(error) => return Err(Box::new(error)),
    };
    let changes = contents
        .lines()
        .filter_map(|line| serde_json::from_str::<SyncChange>(line).ok())
        .rev()
        .take(MAX_PENDING_CHANGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    Ok(changes)
}

#[tauri::command]
pub fn get_sync_roots(state: State<'_, SyncState>) -> Result<Vec<SyncRoot>, String> {
    state
        .roots
        .lock()
        .map(|roots| roots.clone())
        .map_err(|_| "Sync root state is unavailable".to_owned())
}

#[tauri::command]
pub async fn get_sync_storage_usage(state: State<'_, SyncState>) -> Result<String, String> {
    let roots = state
        .roots
        .lock()
        .map_err(|_| "Sync root state is unavailable".to_owned())?
        .clone();
    let manifest = state
        .manifest
        .lock()
        .map_err(|_| "Sync manifest is unavailable".to_owned())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage_bytes_for_manifest(&roots, &manifest).map(|bytes| bytes.to_string())
    })
    .await
    .map_err(|_| "Could not measure CloudFusion sync storage".to_owned())?
}

#[tauri::command]
pub fn set_sync_destination(
    root_id: String,
    remote_node_id: Option<String>,
    state: State<'_, SyncState>,
) -> Result<SyncRoot, String> {
    Uuid::parse_str(&root_id)
        .map_err(|_| "El identificador de la carpeta local no es válido".to_owned())?;
    if let Some(id) = remote_node_id.as_deref() {
        Uuid::parse_str(id)
            .map_err(|_| "El identificador de la carpeta CloudFusion no es válido".to_owned())?;
    }

    let mut roots = state
        .roots
        .lock()
        .map_err(|_| "Sync root state is unavailable".to_owned())?;
    let index = roots
        .iter()
        .position(|root| root.id == root_id)
        .ok_or_else(|| "Sync folder not found".to_owned())?;
    let previous = roots[index].clone();
    roots[index].remote_node_id = remote_node_id;
    if let Err(error) = state.save_roots(&roots) {
        roots[index] = previous;
        return Err(error);
    }
    let saved = roots[index].clone();
    drop(roots);

    if previous.remote_node_id != saved.remote_node_id {
        let mut manifest = state
            .manifest
            .lock()
            .map_err(|_| "Sync manifest is unavailable".to_owned())?;
        let previous_files = manifest.roots.remove(&root_id);
        if let Err(error) = state.save_manifest(&manifest) {
            if let Some(files) = previous_files {
                manifest.roots.insert(root_id.clone(), files);
            }
            drop(manifest);
            if let Ok(mut roots) = state.roots.lock() {
                if let Some(root) = roots.iter_mut().find(|root| root.id == root_id) {
                    *root = previous;
                    let _ = state.save_roots(&roots);
                }
            }
            return Err(error);
        }
    }
    Ok(saved)
}

#[tauri::command]
pub async fn list_sync_files(
    root_id: String,
    state: State<'_, SyncState>,
) -> Result<Vec<String>, String> {
    let root = state.get_root(&root_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let canonical_root = fs::canonicalize(&root.path).map_err(|error| error.to_string())?;
        let mut files = Vec::new();
        collect_sync_files(&canonical_root, &canonical_root, &mut files)?;
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn upload_sync_change(
    root_id: String,
    relative_path: String,
    api_url: String,
    access_token: String,
    state: State<'_, SyncState>,
) -> Result<SyncUploadReceipt, String> {
    Uuid::parse_str(&root_id)
        .map_err(|_| "El identificador de la carpeta local no es válido".to_owned())?;
    let root = state.get_root(&root_id)?;
    let remote_root_id = root
        .remote_node_id
        .clone()
        .ok_or_else(|| "Elige primero una carpeta de destino en Mi Drive".to_owned())?;
    Uuid::parse_str(&remote_root_id)
        .map_err(|_| "El destino de CloudFusion ya no es válido".to_owned())?;
    validate_relative_path(&relative_path)?;
    let api_url = reqwest::Url::parse(&api_url)
        .map_err(|_| "La dirección de CloudFusion no es válida".to_owned())?;
    if !matches!(api_url.scheme(), "http" | "https") || api_url.host_str().is_none() {
        return Err("La dirección de CloudFusion debe usar HTTP o HTTPS".to_owned());
    }
    if access_token.trim().is_empty() || access_token.len() > 16_384 {
        return Err("La sesión expiró; vuelve a iniciar sesión en CloudFusion".to_owned());
    }

    let file_root = root.path.clone();
    let file_relative_path = relative_path.clone();
    let (file_path, initial_checksum) = tauri::async_runtime::spawn_blocking(move || {
        let file_path = resolve_sync_file(&file_root, &file_relative_path)?;
        let checksum = hash_file(&file_path)?;
        Ok::<_, String>((file_path, checksum))
    })
    .await
    .map_err(|error| error.to_string())??;

    let stored = state.get_file_state(&root_id, &relative_path)?;
    let remote_path = stored
        .as_ref()
        .map(|file| file.remote_path.clone())
        .unwrap_or_else(|| relative_path.clone());
    let expected_version_id = stored.map(|file| file.version_id);
    let upload_file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|_| "No se pudo abrir el archivo local para sincronizar".to_owned())?;
    let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(upload_file));
    let endpoint = format!(
        "{}/virtual-drive/sync-upload",
        api_url.as_str().trim_end_matches('/')
    );
    let relative_path_header = URL_SAFE_NO_PAD.encode(remote_path.as_bytes());
    let mut request = reqwest::Client::new()
        .post(endpoint)
        .bearer_auth(&access_token)
        .header("content-type", "application/octet-stream")
        .header("x-cloudfusion-sync-root", &remote_root_id)
        .header("x-cloudfusion-sync-path", relative_path_header)
        .header("x-cloudfusion-sync-checksum", &initial_checksum);
    if let Some(version_id) = expected_version_id {
        request = request.header("x-cloudfusion-sync-version", version_id);
    }
    let response = request.body(body).send().await.map_err(|_| {
        "No se pudo conectar con CloudFusion para sincronizar el archivo".to_owned()
    })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => "La sesión expiró; vuelve a iniciar sesión en CloudFusion".to_owned(),
            403 | 404 => "No tienes acceso a la carpeta de destino de CloudFusion".to_owned(),
            409 => "Hay un conflicto en la ruta remota; revisa Mi Drive".to_owned(),
            413 => "El archivo supera el límite de subida configurado".to_owned(),
            status => format!("CloudFusion rechazó la sincronización (HTTP {status})"),
        });
    }
    let envelope = response
        .json::<ApiEnvelope<SyncUploadResponse>>()
        .await
        .map_err(|_| "CloudFusion devolvió una confirmación de sync no válida".to_owned())?;
    let uploaded = envelope.data;
    if uploaded.node.status == "UNAVAILABLE"
        || (uploaded.replicas == 0 && uploaded.warning.is_some())
    {
        return Err(uploaded.warning.clone().unwrap_or_else(|| {
            "No hay una cuenta cloud disponible para guardar el archivo".to_owned()
        }));
    }
    let version = uploaded
        .version
        .ok_or_else(|| "CloudFusion no devolvió la versión del archivo sincronizado".to_owned())?;
    let current_version_id = uploaded.node.current_version_id.unwrap_or(version.id);
    Uuid::parse_str(&current_version_id)
        .map_err(|_| "CloudFusion devolvió un identificador de versión no válido".to_owned())?;
    let resolved_remote_path = if uploaded.conflict {
        let parent = remote_path.rsplit_once('/').map(|(parent, _)| parent);
        match parent {
            Some(parent) => format!("{parent}/{}", uploaded.node.name),
            None => uploaded.node.name.clone(),
        }
    } else {
        remote_path
    };
    validate_relative_path(&resolved_remote_path)?;

    let verify_path = file_path.clone();
    let final_checksum = tauri::async_runtime::spawn_blocking(move || hash_file(&verify_path))
        .await
        .map_err(|error| error.to_string())??;
    let final_size = fs::metadata(&file_path)
        .map_err(|_| "No se pudo verificar el tamaño final del archivo local".to_owned())?
        .len();
    if !version.checksum.eq_ignore_ascii_case(&final_checksum) || version.size != final_size {
        return Err("El archivo local cambió durante la subida; el cambio sigue pendiente y se volverá a intentar".to_owned());
    }
    {
        let mut manifest = state
            .manifest
            .lock()
            .map_err(|_| "Sync manifest is unavailable".to_owned())?;
        manifest.roots.entry(root_id.clone()).or_default().insert(
            relative_path.clone(),
            SyncedFileState {
                remote_path: resolved_remote_path.clone(),
                version_id: current_version_id.clone(),
                checksum: Some(final_checksum.clone()),
                size_bytes: Some(final_size),
                version_number: version.version_number,
            },
        );
        state.save_manifest(&manifest)?;
    }
    state
        .local_file_index
        .write()
        .map_err(|_| "El índice local para P2P no está disponible".to_owned())?
        .insert((final_checksum.clone(), final_size), file_path);

    Ok(SyncUploadReceipt {
        root_id,
        relative_path,
        remote_path: resolved_remote_path,
        node_id: uploaded.node.id,
        version_id: current_version_id,
        content_hash: final_checksum,
        size_bytes: final_size.to_string(),
        conflict: uploaded.conflict,
        unchanged: uploaded.unchanged,
        warning: uploaded.warning,
    })
}

#[tauri::command]
pub async fn choose_sync_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a folder to sync with CloudFusion")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_sync_root(path: String, state: State<'_, SyncState>) -> Result<SyncRoot, String> {
    let canonical_path = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    if !canonical_path.is_dir() {
        return Err("Select an existing folder to synchronize".to_owned());
    }
    let root = SyncRoot {
        id: Uuid::new_v4().to_string(),
        path: canonical_path.to_string_lossy().into_owned(),
        remote_node_id: None,
    };

    let mut roots = state
        .roots
        .lock()
        .map_err(|_| "Sync root state is unavailable".to_owned())?;
    if roots
        .iter()
        .any(|item| item.path.eq_ignore_ascii_case(&root.path))
    {
        return Err("This folder is already registered for sync".to_owned());
    }
    state.attach_watcher(&root)?;
    roots.push(root.clone());
    if let Err(error) = state.save_roots(&roots) {
        roots.retain(|item| item.id != root.id);
        if let Ok(mut watchers) = state.watchers.lock() {
            watchers.remove(&root.id);
        }
        return Err(error);
    }
    Ok(root)
}

#[tauri::command]
pub fn remove_sync_root(id: String, state: State<'_, SyncState>) -> Result<(), String> {
    let mut roots = state
        .roots
        .lock()
        .map_err(|_| "Sync root state is unavailable".to_owned())?;
    if !roots.iter().any(|root| root.id == id) {
        return Err("Sync folder not found".to_owned());
    }
    let previous = roots.clone();
    roots.retain(|root| root.id != id);
    if let Err(error) = state.save_roots(&roots) {
        *roots = previous;
        return Err(error);
    }
    state
        .watchers
        .lock()
        .map_err(|_| "Sync watcher state is unavailable".to_owned())?
        .remove(&id);
    Ok(())
}

#[tauri::command]
pub fn get_pending_sync_changes(
    limit: Option<usize>,
    state: State<'_, SyncState>,
) -> Result<Vec<SyncChange>, String> {
    let limit = limit.unwrap_or(100).clamp(1, MAX_PENDING_CHANGES);
    state
        .pending
        .lock()
        .map(|changes| changes.iter().take(limit).cloned().collect())
        .map_err(|_| "Sync change queue is unavailable".to_owned())
}

#[tauri::command]
pub fn acknowledge_sync_change(id: String, state: State<'_, SyncState>) -> Result<bool, String> {
    state.acknowledge_change(&id)
}

#[tauri::command]
pub fn get_sync_manifest(
    root_id: String,
    state: State<'_, SyncState>,
) -> Result<Vec<SyncManifestEntry>, String> {
    Uuid::parse_str(&root_id)
        .map_err(|_| "El identificador de la carpeta local no es v\u{00e1}lido".to_owned())?;
    state.get_manifest_entries(&root_id)
}

#[tauri::command]
pub fn get_sync_download_staging_path(
    root_id: String,
    remote_path: String,
    version_id: String,
    state: State<'_, SyncState>,
) -> Result<String, String> {
    Uuid::parse_str(&root_id)
        .map_err(|_| "El identificador de la carpeta local no es v\u{00e1}lido".to_owned())?;
    Uuid::parse_str(&version_id)
        .map_err(|_| "El identificador de versi\u{00f3}n remota no es v\u{00e1}lido".to_owned())?;
    validate_relative_path(&remote_path)?;
    let root = state.get_root(&root_id)?;
    if root.remote_node_id.is_none() {
        return Err("La carpeta local no tiene un destino de CloudFusion configurado".to_owned());
    }
    state
        .staging_path(&root, &remote_path, &version_id)
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn install_sync_download(
    root_id: String,
    remote_path: String,
    node_id: String,
    version_id: String,
    checksum: String,
    size_bytes: String,
    version_number: u64,
    staging_path: String,
    state: State<'_, SyncState>,
) -> Result<RemoteSyncReceipt, String> {
    let size_bytes = size_bytes
        .parse::<u64>()
        .map_err(|_| "El tama\u{00f1}o remoto del archivo no es v\u{00e1}lido".to_owned())?;
    state.install_remote_stage(
        &root_id,
        &remote_path,
        &node_id,
        &version_id,
        &checksum,
        size_bytes,
        version_number,
        Path::new(&staging_path),
    )
}

#[tauri::command]
pub async fn download_sync_version_from_cloud(
    root_id: String,
    remote_path: String,
    node_id: String,
    version_id: String,
    checksum: String,
    size_bytes: String,
    version_number: u64,
    api_url: String,
    access_token: String,
    state: State<'_, SyncState>,
) -> Result<RemoteSyncReceipt, String> {
    Uuid::parse_str(&node_id)
        .map_err(|_| "El identificador del archivo remoto no es v\u{00e1}lido".to_owned())?;
    Uuid::parse_str(&version_id)
        .map_err(|_| "El identificador de versi\u{00f3}n remota no es v\u{00e1}lido".to_owned())?;
    validate_relative_path(&remote_path)?;
    validate_checksum(&checksum)?;
    let size_bytes = size_bytes
        .parse::<u64>()
        .map_err(|_| "El tama\u{00f1}o remoto del archivo no es v\u{00e1}lido".to_owned())?;
    if access_token.trim().is_empty() || access_token.len() > 16_384 {
        return Err(
            "La sesi\u{00f3}n expir\u{00f3}; inicia sesi\u{00f3}n de nuevo para sincronizar"
                .to_owned(),
        );
    }
    let api_url = reqwest::Url::parse(&api_url)
        .map_err(|_| "La direcci\u{00f3}n de CloudFusion no es v\u{00e1}lida".to_owned())?;
    if !matches!(api_url.scheme(), "http" | "https") || api_url.host_str().is_none() {
        return Err("La direcci\u{00f3}n de CloudFusion debe usar HTTP o HTTPS".to_owned());
    }
    let root = state.get_root(&root_id)?;
    if root.remote_node_id.is_none() {
        return Err("La carpeta local no tiene un destino de CloudFusion configurado".to_owned());
    }
    let staging_path = state.staging_path(&root, &remote_path, &version_id)?;
    let endpoint = format!(
        "{}/virtual-drive/nodes/{}/versions/{}/download",
        api_url.as_str().trim_end_matches('/'),
        node_id,
        version_id,
    );
    let response = reqwest::Client::new()
        .get(endpoint)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|_| "No se pudo conectar con CloudFusion para recibir el archivo".to_owned())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 => "La sesi\u{00f3}n expir\u{00f3}; inicia sesi\u{00f3}n de nuevo para sincronizar"
                .to_owned(),
            403 | 404 => "No tienes acceso a la versi\u{00f3}n remota solicitada".to_owned(),
            status => format!("CloudFusion no pudo descargar la versi\u{00f3}n (HTTP {status})"),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length != size_bytes)
    {
        return Err(
            "CloudFusion anunci\u{00f3} un tama\u{00f1}o de descarga inesperado".to_owned(),
        );
    }
    let mut output = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&staging_path)
        .await
        .map_err(|_| "No se pudo crear el archivo temporal de sincronizaci\u{00f3}n".to_owned())?;
    let mut stream = response.bytes_stream();
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "La descarga remota se interrumpi\u{00f3}".to_owned())?;
        received = received.checked_add(chunk.len() as u64).ok_or_else(|| {
            "El tama\u{00f1}o de descarga super\u{00f3} el l\u{00ed}mite".to_owned()
        })?;
        if received > size_bytes {
            let _ = tokio::fs::remove_file(&staging_path).await;
            return Err(
                "CloudFusion envi\u{00f3} m\u{00e1}s bytes que el tama\u{00f1}o verificado"
                    .to_owned(),
            );
        }
        hasher.update(&chunk);
        output
            .write_all(&chunk)
            .await
            .map_err(|_| "No se pudo guardar el bloque descargado".to_owned())?;
    }
    output
        .flush()
        .await
        .map_err(|_| "No se pudo completar la descarga temporal".to_owned())?;
    output
        .sync_data()
        .await
        .map_err(|_| "No se pudo persistir la descarga temporal".to_owned())?;
    drop(output);
    let downloaded_checksum = hex_bytes(&hasher.finalize());
    if received != size_bytes || !downloaded_checksum.eq_ignore_ascii_case(&checksum) {
        let _ = tokio::fs::remove_file(&staging_path).await;
        return Err(
            "La descarga no coincide con el tama\u{00f1}o y SHA-256 de la versi\u{00f3}n"
                .to_owned(),
        );
    }
    state.install_remote_stage(
        &root_id,
        &remote_path,
        &node_id,
        &version_id,
        &checksum,
        size_bytes,
        version_number,
        &staging_path,
    )
}

#[cfg(test)]
mod tests {
    use super::{
        build_local_file_index, conflict_relative_path, load_recent_changes,
        local_matches_manifest, storage_bytes_for_manifest, sync_file_matches,
        validate_relative_path, SyncChange, SyncManifest, SyncRoot, SyncedFileState,
        MAX_PENDING_CHANGES,
    };
    use std::{collections::HashMap, fs, path::PathBuf};
    use uuid::Uuid;

    #[test]
    fn journal_restores_only_the_most_recent_bounded_changes() {
        let file = std::env::temp_dir().join(format!("cloudfusion-sync-{}.jsonl", Uuid::new_v4()));
        let changes = (0..(MAX_PENDING_CHANGES + 5))
            .map(|index| SyncChange {
                id: index.to_string(),
                root_id: "root".to_owned(),
                relative_path: format!("file-{index}.txt"),
                operation: "modified".to_owned(),
                detected_at_ms: index as u128,
            })
            .collect::<Vec<_>>();
        let mut serialized = changes
            .iter()
            .map(|change| serde_json::to_string(change).expect("change serializes"))
            .collect::<Vec<_>>()
            .join("\n");
        serialized.push('\n');
        fs::write(&file, serialized).expect("journal writes");

        let restored = load_recent_changes(&file).expect("journal restores");
        assert_eq!(restored.len(), MAX_PENDING_CHANGES);
        assert_eq!(restored.front().map(|change| change.id.as_str()), Some("5"));
        fs::remove_file(PathBuf::from(file)).expect("test journal cleans up");
    }

    #[test]
    fn local_index_hashes_files_and_keeps_paths_out_of_the_result() {
        let root = std::env::temp_dir().join(format!("cloudfusion-index-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("test root creates");
        fs::write(root.join("local-copy.txt"), b"abc").expect("test file writes");
        let roots = [SyncRoot {
            id: "root-id".to_owned(),
            path: root.to_string_lossy().into_owned(),
            remote_node_id: None,
        }];

        let index = build_local_file_index(&roots).expect("local files index");
        assert_eq!(index.len(), 1);
        assert!(index.contains_key(&(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(),
            3
        )));

        assert_eq!(index.len(), 1);
        fs::remove_dir_all(&root).expect("test root cleans up");
    }

    #[test]
    fn storage_usage_counts_only_present_cloudfusion_files_at_their_manifest_size() {
        let root_path =
            std::env::temp_dir().join(format!("cloudfusion-storage-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_path).expect("test root creates");
        fs::write(root_path.join("managed.txt"), b"abc").expect("managed file writes");
        fs::write(root_path.join("changed.txt"), b"changed").expect("changed file writes");
        fs::write(root_path.join("untracked.txt"), b"untracked").expect("untracked file writes");

        let root_id = Uuid::new_v4().to_string();
        let root = SyncRoot {
            id: root_id.clone(),
            path: root_path.to_string_lossy().into_owned(),
            remote_node_id: Some(Uuid::new_v4().to_string()),
        };
        let file = |size_bytes| SyncedFileState {
            remote_path: "unused".to_owned(),
            version_id: "version".to_owned(),
            checksum: Some("a".repeat(64)),
            size_bytes: Some(size_bytes),
            version_number: 1,
        };
        let manifest = SyncManifest {
            roots: HashMap::from([(
                root_id,
                HashMap::from([
                    ("managed.txt".to_owned(), file(3)),
                    ("changed.txt".to_owned(), file(1)),
                    ("missing.txt".to_owned(), file(20)),
                    (
                        "unverified.txt".to_owned(),
                        SyncedFileState {
                            remote_path: "unverified.txt".to_owned(),
                            version_id: "version".to_owned(),
                            checksum: None,
                            size_bytes: Some(10),
                            version_number: 0,
                        },
                    ),
                ]),
            )]),
        };

        let used = storage_bytes_for_manifest(&[root], &manifest).expect("storage usage measures");

        assert_eq!(used, 3);
        fs::remove_dir_all(&root_path).expect("test root cleans up");
    }

    #[test]
    fn storage_usage_requires_a_remote_cloudfusion_sync_root() {
        let root_path =
            std::env::temp_dir().join(format!("cloudfusion-local-root-{}", Uuid::new_v4()));
        fs::create_dir_all(&root_path).expect("test root creates");
        let root = SyncRoot {
            id: Uuid::new_v4().to_string(),
            path: root_path.to_string_lossy().into_owned(),
            remote_node_id: None,
        };

        let error = storage_bytes_for_manifest(&[root], &SyncManifest::default())
            .expect_err("a local-only folder cannot contribute CloudFusion storage");

        assert!(error.contains("configured CloudFusion sync folder"));
        fs::remove_dir_all(root_path).expect("test root cleans up");
    }

    #[test]
    fn local_sync_copy_verification_checks_path_size_and_checksum() {
        let root = std::env::temp_dir().join(format!("cloudfusion-verify-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("test root creates");
        fs::write(root.join("copy.txt"), b"abc").expect("test file writes");
        let root_path = root.to_string_lossy().into_owned();
        let checksum = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

        assert!(sync_file_matches(&root_path, "copy.txt", checksum, 3));
        assert!(!sync_file_matches(&root_path, "copy.txt", checksum, 4));
        assert!(!sync_file_matches(
            &root_path,
            "../outside.txt",
            checksum,
            3
        ));

        fs::remove_dir_all(&root).expect("test root cleans up");
    }

    #[test]
    fn sync_paths_reject_traversal_and_windows_special_names() {
        assert!(validate_relative_path("docs/report.pdf").is_ok());
        assert!(validate_relative_path("../outside.txt").is_err());
        assert!(validate_relative_path("folder/../outside.txt").is_err());
        assert!(validate_relative_path("folder/file:name.txt").is_err());
        assert!(validate_relative_path("folder\\file.txt").is_err());
    }

    #[test]
    fn remote_conflicts_keep_the_original_name_and_are_stable_per_version() {
        let first = conflict_relative_path(
            "reports/quarterly.pdf",
            "12345678-aaaa-bbbb-cccc-123456789abc",
        )
        .expect("conflict path is safe");
        let second = conflict_relative_path(
            "reports/quarterly.pdf",
            "12345678-aaaa-bbbb-cccc-123456789abc",
        )
        .expect("conflict path is stable");
        assert_eq!(
            first,
            "reports/quarterly (CloudFusion conflict 12345678).pdf"
        );
        assert_eq!(first, second);
        assert!(validate_relative_path(&first).is_ok());
    }

    #[test]
    fn only_a_local_copy_matching_its_saved_baseline_can_be_replaced() {
        let checksum = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(local_matches_manifest(Some(checksum), Some(3), checksum, 3));
        let uppercase_checksum = checksum.to_uppercase();
        assert!(local_matches_manifest(
            Some(uppercase_checksum.as_str()),
            Some(3),
            checksum,
            3
        ));
        assert!(!local_matches_manifest(
            Some(checksum),
            Some(4),
            checksum,
            3
        ));
        assert!(!local_matches_manifest(None, Some(3), checksum, 3));
    }

    #[test]
    fn old_sync_manifests_load_without_download_metadata() {
        let manifest: SyncManifest = serde_json::from_str(
            r#"{"roots":{"root":{"file.txt":{"remotePath":"file.txt","versionId":"version"}}}}"#,
        )
        .expect("legacy manifest remains readable");
        let file = manifest
            .roots
            .get("root")
            .and_then(|files| files.get("file.txt"))
            .expect("legacy file entry loads");
        assert_eq!(file.checksum, None);
        assert_eq!(file.size_bytes, None);
        assert_eq!(file.version_number, 0);
    }
}
