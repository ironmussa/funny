mod pty;

use tauri::Emitter;
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

/// Injected content script that powers the Tauri annotator window.
/// Mirrors the Chrome-extension UX: hover-highlight + click-to-capture on any
/// origin. Lives outside the JS bundle so it can be `eval`'d as a fresh string
/// inside the target page's document context.
const ANNOTATOR_SCRIPT: &str = include_str!("../injected/annotator.js");

/// Opens a Tauri webview at `url` and injects the annotator content script
/// BEFORE the page loads. The script lives in the page's own document, so it
/// has the same DOM access a content-script from the Chrome extension would —
/// no same-origin / iframe restriction.
///
/// Reuses the existing window when present; reload the target URL if the
/// caller passed a different one.
#[tauri::command]
async fn open_annotator(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: url::Url = url
        .parse()
        .map_err(|e| format!("invalid annotator url: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!(
            "annotator only supports http(s); got {}",
            parsed.scheme()
        ));
    }

    let label = "annotator";

    if let Some(window) = app.get_webview_window(label) {
        // Navigate the existing window to the new URL and re-focus. We don't
        // re-inject the script — the navigation will trigger the existing
        // initialization_script on the new page load.
        window.set_focus().map_err(|e| format!("{e}"))?;
        window
            .eval(&format!("window.location.href = {:?};", parsed.as_str()))
            .map_err(|e| format!("{e}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(parsed))
        .initialization_script(ANNOTATOR_SCRIPT)
        .title("funny — Annotator")
        .inner_size(1280.0, 800.0)
        .min_inner_size(600.0, 400.0)
        .center()
        .build()
        .map_err(|e| format!("{e}"))?;

    Ok(())
}

/// Closes the annotator window if open.
#[tauri::command]
async fn close_annotator(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("annotator") {
        window.close().map_err(|e| format!("{e}"))?;
    }
    Ok(())
}

#[derive(serde::Serialize, Clone)]
struct AnnotatorCapture {
    markdown: String,
    url: String,
}

/// Bridge between the injected annotator content script and the main funny
/// window. The script calls this from inside the page's document; we re-emit
/// the payload as a Tauri event the main window listens for. Side effect:
/// close the annotator window so focus returns to funny automatically.
#[tauri::command]
async fn annotator_send(
    app: tauri::AppHandle,
    markdown: String,
    url: String,
) -> Result<(), String> {
    app.emit("annotator:capture", AnnotatorCapture { markdown, url })
        .map_err(|e| format!("{e}"))?;

    // Bring funny back to the foreground so the prefilled compose UI is
    // immediately visible.
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_focus();
    }
    if let Some(annotator) = app.get_webview_window("annotator") {
        let _ = annotator.close();
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
            open_annotator,
            close_annotator,
            annotator_send,
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
