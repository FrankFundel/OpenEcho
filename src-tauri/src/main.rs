#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(debug_assertions))]
use std::fs;
#[cfg(not(debug_assertions))]
use std::path::PathBuf;
#[cfg(not(debug_assertions))]
use std::process::{Child, Command, Stdio};
#[cfg(debug_assertions)]
use std::process::Child;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, Theme};

struct SidecarState(Mutex<Option<Child>>);

#[cfg(not(debug_assertions))]
fn backend_executable_name() -> &'static str {
  #[cfg(target_os = "windows")]
  {
    "openecho-backend.exe"
  }

  #[cfg(not(target_os = "windows"))]
  {
    "openecho-backend"
  }
}

#[cfg(not(debug_assertions))]
fn backend_executable_path(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
  Ok(
    app.path()
      .resource_dir()?
      .join("python-backend")
      .join(backend_executable_name()),
  )
}

#[cfg(not(debug_assertions))]
fn bundled_tf_worker_path(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
  let worker_path = app
    .path()
    .resource_dir()?
    .join("python-backend")
    .join(".venv-tf");

  #[cfg(target_os = "windows")]
  {
    Ok(worker_path.join("Scripts").join("python.exe"))
  }

  #[cfg(not(target_os = "windows"))]
  {
    Ok(worker_path.join("bin").join("python"))
  }
}

fn kill_sidecar(app: &tauri::AppHandle) {
  let state = app.state::<SidecarState>();
  let mut child = state.0.lock().unwrap();
  if let Some(child) = child.as_mut() {
    let _ = child.kill();
    let _ = child.wait();
  }
  *child = None;
}

fn main() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(SidecarState(Mutex::new(None)))
    .setup(|_app| {
      if let Some(window) = _app.get_webview_window("main") {
        let _ = window.set_theme(Some(Theme::Dark));
        if let Some(icon) = _app.default_window_icon().cloned() {
          let _ = window.set_icon(icon);
        }
      }

      #[cfg(not(debug_assertions))]
      {
        let app_data_dir = _app.path().app_data_dir()?;
        fs::create_dir_all(&app_data_dir)?;

        let backend_path = backend_executable_path(&_app.handle())?;
        let mut command = Command::new(&backend_path);
        command
          .args(["--host", "127.0.0.1", "--port", "8420"])
          .current_dir(&app_data_dir)
          .env("OPENECHO_DATA_DIR", app_data_dir.to_string_lossy().to_string())
          .stdout(Stdio::inherit())
          .stderr(Stdio::inherit());

        let tf_worker_path = bundled_tf_worker_path(&_app.handle())?;
        if tf_worker_path.is_file() {
          command.env("BACPIPE_TF_PYTHON", tf_worker_path.to_string_lossy().to_string());
        }

        let child = command.spawn()?;

        *_app.state::<SidecarState>().0.lock().unwrap() = Some(child);
      }

      Ok(())
    });

  builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| match event {
      RunEvent::Exit | RunEvent::ExitRequested { .. } => kill_sidecar(app),
      _ => {}
    });
}
