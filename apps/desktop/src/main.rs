mod device;
mod mesh;
mod storage;
mod sync;
mod transfer;

use device::DeviceIdentity;
use mesh::MeshManager;
use sync::SyncState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let identity = DeviceIdentity::load_or_create()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let sync_state = SyncState::load(app.handle().clone(), &data_dir)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let device_storage_state = storage::DeviceStorageState::load(&data_dir)
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            app.manage(identity);
            let local_file_index = sync_state.shared_local_file_index();
            app.manage(sync_state);
            app.manage(device_storage_state);
            app.manage(MeshManager::new(local_file_index));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            device::get_device_registration,
            device::get_refresh_token,
            device::store_refresh_token,
            device::delete_refresh_token,
            mesh::set_trusted_mesh_peers,
            mesh::configure_mesh_api,
            mesh::start_lan_mesh,
            mesh::stop_lan_mesh,
            sync::get_sync_roots,
            sync::get_sync_storage_usage,
            storage::get_device_storage_root,
            storage::choose_device_storage_folder,
            storage::set_device_storage_root,
            storage::get_device_storage_usage,
            storage::index_device_storage_files,
            storage::store_device_replica,
            sync::set_sync_destination,
            sync::choose_sync_folder,
            sync::add_sync_root,
            sync::remove_sync_root,
            sync::get_pending_sync_changes,
            sync::acknowledge_sync_change,
            sync::get_sync_manifest,
            sync::get_sync_download_staging_path,
            sync::install_sync_download,
            sync::download_sync_version_from_cloud,
            sync::list_sync_files,
            sync::upload_sync_change,
            sync::index_sync_files,
            sync::has_indexed_file_version,
            sync::verify_sync_file_copy,
            transfer::choose_p2p_destination,
            transfer::download_p2p_file
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CloudFusion desktop");
}
