mod pty;

use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

struct ServerProcess(std::sync::Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(pty::PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .setup(|app| {
            // Spawn the server sidecar on startup
            let shell = app.shell();
            let sidecar = shell
                .sidecar("a-parallel-server")
                .expect("failed to create sidecar command");

            let (_rx, child) = sidecar
                .spawn()
                .expect("failed to spawn server sidecar");

            // Store the child process so we can kill it on exit
            app.manage(ServerProcess(std::sync::Mutex::new(Some(child))));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Kill all PTY instances
            if let Some(pty_state) = app_handle.try_state::<pty::PtyManager>() {
                pty::kill_all(&pty_state);
            }

            // Kill the server process on app exit
            if let Some(state) = app_handle.try_state::<ServerProcess>() {
                if let Ok(mut guard) = state.0.lock() {
                    if let Some(child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}
