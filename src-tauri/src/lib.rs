mod pty;

use tauri::Manager;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

struct ServerProcess(std::sync::Mutex<Option<CommandChild>>);

/// Opens the single preview browser window. If it already exists, focuses it.
/// The window loads index.html with a flag so the frontend renders the preview UI.
#[tauri::command]
async fn open_preview(app: tauri::AppHandle) -> Result<(), String> {
    let label = "preview-browser";

    // If window already exists, focus it
    if let Some(window) = app.get_webview_window(label) {
        window.set_focus().map_err(|e| format!("{e}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App(std::path::PathBuf::from("index.html")),
    )
    .initialization_script("window.__PREVIEW_MODE__ = true;")
    .title("Preview Browser")
    .inner_size(1280.0, 800.0)
    .min_inner_size(600.0, 400.0)
    .center()
    .build()
    .map_err(|e| format!("{e}"))?;

    Ok(())
}

/// Closes the preview browser window.
#[tauri::command]
async fn close_preview(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("preview-browser") {
        window.close().map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

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
            open_preview,
            close_preview,
        ])
        .setup(|app| {
            // Spawn the server sidecar on startup
            let shell = app.shell();
            let sidecar = shell
                .sidecar("funny-server")
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
