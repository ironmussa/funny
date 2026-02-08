use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

type TerminalId = String;

struct PtyInstance {
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send + Sync>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

pub struct PtyManager {
    instances: Mutex<HashMap<TerminalId, PtyInstance>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    data: String,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyManager>,
    id: String,
    cwd: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Determine default shell
    let shell_path = if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    };

    let mut cmd = CommandBuilder::new(&shell_path);
    cmd.cwd(&cwd);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Store instance
    {
        let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
        instances.insert(
            id.clone(),
            PtyInstance {
                child,
                writer,
                master: pair.master,
            },
        );
    }

    // Spawn reader thread: reads PTY output and emits events to frontend
    let data_event = format!("pty:data:{}", id);
    let exit_event = format!("pty:exit:{}", id);

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(&data_event, PtyDataPayload { data: text });
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(&exit_event, ());
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
    let instance = instances.get_mut(&id).ok_or("Terminal not found")?;
    instance
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    instance.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let instances = state.instances.lock().map_err(|e| e.to_string())?;
    let instance = instances.get(&id).ok_or("Terminal not found")?;
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyManager>, id: String) -> Result<(), String> {
    let mut instances = state.instances.lock().map_err(|e| e.to_string())?;
    if let Some(mut instance) = instances.remove(&id) {
        let _ = instance.child.kill();
    }
    Ok(())
}

/// Kill all PTY instances — called on app exit
pub fn kill_all(state: &PtyManager) {
    if let Ok(mut instances) = state.instances.lock() {
        for (_, mut inst) in instances.drain() {
            let _ = inst.child.kill();
        }
    }
}
