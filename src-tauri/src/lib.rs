use std::path::PathBuf;

/// Locate a Python script: first look next to Cargo.toml (dev), then next to the exe (release).
fn find_script(name: &str) -> PathBuf {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(name);
    if dev.exists() {
        return dev;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(name);
            if p.exists() {
                return p;
            }
        }
    }
    PathBuf::from(name)
}

/// Apply blur / mosaic regions to a single photo via photo_blur.py
#[tauri::command]
fn apply_photo_blur(
    input_path: String,
    regions: Vec<serde_json::Value>,
    output_path: String,
) -> Result<(), String> {
    let script = find_script("photo_blur.py");
    let regions_json = serde_json::to_string(&regions)
        .map_err(|e| format!("JSON error: {}", e))?;

    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create output folder: {}", e))?;
    }

    let out = std::process::Command::new("python")
        .args([
            script.to_str().unwrap_or("photo_blur.py"),
            &input_path,
            &regions_json,
            &output_path,
        ])
        .output()
        .map_err(|e| format!("Failed to launch Python: {}", e))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("photo_blur.py failed: {}", stderr));
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
