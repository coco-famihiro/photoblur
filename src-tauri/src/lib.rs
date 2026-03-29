use std::path::PathBuf;

/// Build a Command that runs photo_blur:
///   - Release: photo_blur.exe (sidecar, next to our own exe)
///   - Dev:     python photo_blur.py (from repo root)
///
/// In both cases, call `.args([input, regions_json, output])` on the result.
fn build_photo_blur_command() -> std::process::Command {
    // Release: look for photo_blur.exe next to our own executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join("photo_blur.exe");
            if sidecar.exists() {
                return std::process::Command::new(sidecar);
            }
        }
    }

    // Dev: python + photo_blur.py from repo root (parent of src-tauri/)
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("photo_blur.py");

    let mut cmd = std::process::Command::new("python");
    cmd.arg(script);
    cmd
}

/// Apply blur / mosaic regions to a single photo via photo_blur (exe or py)
#[tauri::command]
fn apply_photo_blur(
    input_path: String,
    regions: Vec<serde_json::Value>,
    output_path: String,
) -> Result<(), String> {
    let regions_json = serde_json::to_string(&regions)
        .map_err(|e| format!("JSON error: {}", e))?;

    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create output folder: {}", e))?;
    }

    let out = build_photo_blur_command()
        .args([&input_path, &regions_json, &output_path])
        .output()
        .map_err(|e| format!("Failed to launch photo_blur: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!("photo_blur failed:\nstderr: {}\nstdout: {}", stderr, stdout));
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![apply_photo_blur])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
