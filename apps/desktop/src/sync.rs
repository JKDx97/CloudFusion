use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_PENDING_CHANGES: usize = 500;

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
        let journal_lock = Arc::clone(&self.journal_lock);
        let journal_file = Arc::clone(&self.journal_file);
        let event_root_path = root_path.clone();

        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            let Ok(event) = result else { return };
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
    use super::{load_recent_changes, SyncChange, MAX_PENDING_CHANGES};
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
}
