use std::path::PathBuf;
use std::process::Command;

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

/// Looks for an existing K2 install by scanning the Windows uninstall
/// registry hive for a product whose DisplayName starts with "K2". This
/// mirrors how the legacy SourceCode.SetupManager installer decided
/// whether to show its Maintenance screen instead of a fresh install wizard.
#[tauri::command]
pub fn detect_k2_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        const UNINSTALL_KEYS: [&str; 2] = [
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ];

        for key in UNINSTALL_KEYS {
            let output = Command::new("reg").args(["query", key, "/s", "/f", "K2", "/d"]).output();
            if let Ok(output) = output {
                if output.status.success() && !output.stdout.is_empty() {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
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
