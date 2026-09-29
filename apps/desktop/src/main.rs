mod device;
mod mesh;
mod sync;

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

            app.manage(identity);
            app.manage(sync_state);
            app.manage(MeshManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            device::get_device_registration,
            device::get_refresh_token,
            device::store_refresh_token,
            device::delete_refresh_token,
            mesh::set_trusted_mesh_peers,
            mesh::start_lan_mesh,
            mesh::stop_lan_mesh,
            sync::get_sync_roots,
            sync::choose_sync_folder,
            sync::add_sync_root,
            sync::remove_sync_root,
            sync::get_pending_sync_changes
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CloudFusion desktop");
}
