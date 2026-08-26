use std::fs;

use serde::Serialize;

/// Mirrors the legacy installer's `setupmanager.exe /output:bp.xml` (write
/// an answer file instead of installing) and `setup.exe /install:bp.xml`
/// (install from that file, no wizard) command-line switches. Accepts
/// both that literal `/flag:value` syntax and a `--flag=value` variant.
#[derive(Serialize)]
pub struct LaunchArgs {
    pub output: Option<String>,
    pub install: Option<String>,
}

fn extract_value<'a>(arg: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    prefixes.iter().find_map(|prefix| arg.strip_prefix(prefix))
}

#[tauri::command]
pub fn get_launch_args() -> LaunchArgs {
    let mut output = None;
    let mut install = None;

    for arg in std::env::args().skip(1) {
        if let Some(value) = extract_value(&arg, &["/output:", "--output="]) {
            output = Some(value.to_string());
        } else if let Some(value) = extract_value(&arg, &["/install:", "--install="]) {
            install = Some(value.to_string());
        }
    }

    LaunchArgs { output, install }
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<String, String> {
    let path_buf = std::path::PathBuf::from(&path);
    fs::write(&path_buf, contents).map_err(|e| format!("Failed to write '{path}': {e}"))?;
    Ok(path_buf.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Failed to read '{path}': {e}"))
}
