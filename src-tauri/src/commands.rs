use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

/// The version of K2 this build of the installer deploys. In the legacy
/// SourceCode.SetupManager installer this was a resource string
/// (FRIENDLY_VERSION) with a [FULL_VERSION] placeholder substituted at
/// build time. This is the equivalent single source of truth here: bump
/// these three constants per release, everything else reads from them.
const PRODUCT_NAME: &str = "K2 Five";
const PRODUCT_VERSION: &str = "5.10";
const INSTALL_TYPE: &str = "Full server install";

#[derive(Serialize)]
pub struct ProductInfo {
    pub name: String,
    pub version: String,
    pub full_version: String,
    pub install_type: String,
}

#[tauri::command]
pub fn get_product_info() -> ProductInfo {
    ProductInfo {
        name: PRODUCT_NAME.to_string(),
        version: PRODUCT_VERSION.to_string(),
        full_version: format!("{PRODUCT_NAME} {PRODUCT_VERSION}"),
        install_type: INSTALL_TYPE.to_string(),
    }
}

#[tauri::command]
pub fn hello(name: String) -> String {
    format!("Hello, {name}! You've been greeted from Rust.")
}

/// Looks for a .NET Framework 4.x install by checking the registry-backed
/// release key file that ships on Windows. On non-Windows dev hosts this
/// always reports absent so the UI has something sane to show.
#[tauri::command]
pub fn detect_dotnet() -> bool {
    #[cfg(target_os = "windows")]
    {
        Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full",
                "/v",
                "Release",
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
const UNINSTALL_KEYS: [&str; 2] = [
    r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
];

/// Finds the Windows uninstall registry subkey for an installed K2 product
/// (DisplayName starting with "K2") and reads its DisplayVersion. Mirrors
/// how the legacy SourceCode.SetupManager installer read
/// ComponentManager.ProductConfig.InstalledVersion to decide whether to
/// show its Maintenance screen instead of a fresh install wizard.
#[cfg(target_os = "windows")]
fn find_installed_k2_version() -> Option<String> {
    for root in UNINSTALL_KEYS {
        let subkeys = Command::new("reg").args(["query", root]).output().ok()?;
        let listing = String::from_utf8_lossy(&subkeys.stdout);

        for subkey in listing.lines().map(str::trim).filter(|l| l.starts_with("HKEY")) {
            let display_name = reg_read_value(subkey, "DisplayName");
            if display_name.as_deref().is_some_and(|n| n.starts_with("K2")) {
                return Some(reg_read_value(subkey, "DisplayVersion").unwrap_or_default());
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn reg_read_value(key: &str, value_name: &str) -> Option<String> {
    let output = Command::new("reg").args(["query", key, "/v", value_name]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| l.trim_start().starts_with(value_name))?;
    line.rsplit("    ").next().map(|s| s.trim().to_string())
}

/// Reports whether K2 is already installed on this machine.
#[tauri::command]
pub fn detect_k2_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        find_installed_k2_version().is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Returns the installed K2 version (DisplayVersion from the uninstall
/// registry entry), or None if K2 is not installed.
#[tauri::command]
pub fn get_installed_k2_version() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        find_installed_k2_version()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn dotnet_runner_path() -> PathBuf {
    let mut path = std::env::current_exe().unwrap_or_default();
    path.pop();
    path.push("DotNetRunner.exe");
    path
}

#[tauri::command]
pub fn run_dotnet(input: String) -> Result<String, String> {
    let runner = dotnet_runner_path();
    let output = Command::new(runner)
        .arg(input)
        .output()
        .map_err(|e| format!("Failed to launch DotNetRunner: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
