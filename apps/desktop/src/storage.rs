use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::State;
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
    relative_path: String,
    checksum: String,
    size_bytes: u64,
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
    let bytes = match fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(_) => return Err("No se pudo leer el índice local de réplicas".to_owned()),
    };
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("El índice local de réplicas supera el límite permitido".to_owned());
    }
    let manifest: DeviceReplicaManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "El índice local de réplicas no es válido".to_owned())?;
    let replica_root = manifest_path
        .parent()
        .ok_or_else(|| "No se pudo resolver la carpeta de réplicas".to_owned())?;
    let mut total = 0u64;
    for entry in manifest.entries {
        if entry.relative_path.is_empty()
            || Path::new(&entry.relative_path).is_absolute()
            || entry
                .relative_path
                .chars()
                .any(|character| matches!(character, '/' | '\\' | ':'))
            || entry.relative_path == "."
            || entry.relative_path == ".."
            || entry.checksum.len() != 64
            || !entry.checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
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

#[cfg(test)]
mod tests {
    use super::{paths_overlap, storage_usage, DeviceReplicaManifest};
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
                    relative_path: "known.blob".into(),
                    checksum: "a".repeat(64),
                    size_bytes: 3,
                },
                super::DeviceReplicaEntry {
                    relative_path: "unknown.blob".into(),
                    checksum: "b".repeat(64),
                    size_bytes: 1,
                },
                super::DeviceReplicaEntry {
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
}
