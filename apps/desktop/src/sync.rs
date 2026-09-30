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
    roots: Mutex<Vec<SyncRoot>>,
    local_file_index: Arc<RwLock<LocalFileIndex>>,
    pending: Arc<Mutex<VecDeque<SyncChange>>>,
    journal_lock: Arc<Mutex<()>>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl SyncState {
    pub fn load(app: AppHandle, data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let sync_dir = data_dir.join("sync");
        fs::create_dir_all(&sync_dir)?;
        let roots_file = sync_dir.join("roots.json");
        let journal_file = sync_dir.join("changes.jsonl");
        let roots = match fs::read(&roots_file) {
            Ok(data) => serde_json::from_slice::<Vec<SyncRoot>>(&data)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(Box::new(error)),
        };
        let pending = Arc::new(Mutex::new(load_recent_changes(&journal_file)?));
        let journal_lock = Arc::new(Mutex::new(()));
        let state = Self {
            app,
            roots_file,
            journal_file: Arc::new(journal_file),
            roots: Mutex::new(roots.clone()),
            local_file_index: Arc::new(RwLock::new(HashMap::new())),
            pending,
            journal_lock,
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

    pub(crate) fn shared_local_file_index(&self) -> Arc<RwLock<LocalFileIndex>> {
        Arc::clone(&self.local_file_index)
    }
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

#[cfg(test)]
mod tests {
    use super::{
        build_local_file_index, load_recent_changes, SyncChange, SyncRoot, MAX_PENDING_CHANGES,
    };
    use std::{fs, path::PathBuf};
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
}
