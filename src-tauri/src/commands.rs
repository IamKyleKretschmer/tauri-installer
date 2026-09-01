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
///
/// A real machine's Uninstall key commonly has 50-200+ subkeys (one per
/// installed program). Querying each one individually (as this used to)
/// meant that many `reg.exe` process spawns just to check DisplayName,
/// which is what made the Welcome screen feel slow. `reg query <root> /s
/// /v DisplayName` does the same recursive scan in a single process, and
/// only the one matching key gets a second query for DisplayVersion.
#[cfg(target_os = "windows")]
fn find_installed_k2_version() -> Option<String> {
    for root in UNINSTALL_KEYS {
        let output = Command::new("reg")
            .args(["query", root, "/s", "/v", "DisplayName"])
            .output()
            .ok()?;
        let listing = String::from_utf8_lossy(&output.stdout);

        let mut current_key: Option<&str> = None;
        for line in listing.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("HKEY") {
                current_key = Some(trimmed);
            } else if trimmed.starts_with("DisplayName") {
                let name = trimmed.rsplit("    ").next().unwrap_or("").trim();
                if name.starts_with("K2") {
                    if let Some(key) = current_key {
                        return Some(reg_read_value(key, "DisplayVersion").unwrap_or_default());
                    }
                }
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

/// Locates DotNetRunner.exe. In a bundled/production build it ships next
/// to the K2 Setup executable. In `cargo tauri dev` there is no bundle
/// step, so the exe-adjacent path (target/debug) never has it, this also
/// checks DotNetRunner's own dev build output (`dotnet build` from the
/// DotNetRunner/ directory) so `npm run tauri dev` works without a manual
/// copy step.
fn dotnet_runner_path() -> PathBuf {
    let mut adjacent = std::env::current_exe().unwrap_or_default();
    adjacent.pop();
    adjacent.push("DotNetRunner.exe");
    if adjacent.exists() {
        return adjacent;
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for profile in ["Debug", "Release"] {
        let dev_path = manifest_dir
            .join("..")
            .join("DotNetRunner")
            .join("bin")
            .join(profile)
            .join("net48")
            .join("DotNetRunner.exe");
        if dev_path.exists() {
            return dev_path;
        }
    }

    adjacent
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

/// Characters SQLSvrPanel.HasInvalidChars() rejected in a database name.
const INVALID_DB_NAME_CHARS: [char; 14] =
    ['"', ';', '\\', '/', ':', '*', '?', '<', '>', '|', '&', '\'', '=', ','];

/// Same field validation SQLSvrPanel.ValidateDialog() ran before ever
/// attempting a connection: required/length/reserved-name/character
/// checks on the database name, and required username+password for SQL
/// authentication.
fn validate_sql_fields(auth_mode: &str, username: &str, password: &str, database: &str) -> Result<(), String> {
    let trimmed = database.trim();

    if trimmed.is_empty() {
        return Err("Database name cannot be empty.".to_string());
    }
    if trimmed.len() > 128 {
        return Err("Database name cannot be longer than 128 characters.".to_string());
    }
    if trimmed.eq_ignore_ascii_case("master") {
        return Err("\"master\" is a reserved database name. Choose a different database name.".to_string());
    }
    if trimmed.chars().any(|c| INVALID_DB_NAME_CHARS.contains(&c)) {
        return Err(format!(
            "Database name contains invalid characters. Avoid: {}",
            INVALID_DB_NAME_CHARS.iter().collect::<String>()
        ));
    }
    if auth_mode.eq_ignore_ascii_case("sql") && (username.trim().is_empty() || password.is_empty()) {
        return Err("A username and password are required for SQL Server authentication.".to_string());
    }

    Ok(())
}

/// Tests connectivity to a SQL Server instance and ensures the given
/// database exists (DotNetRunner creates it with the required collation
/// if missing), via `SourceCode.SetupManager`'s reference architecture:
/// Rust spawns the .NET Framework helper and captures its stdout/stderr.
#[tauri::command]
pub fn test_sql_connection(
    instance: String,
    auth_mode: String,
    username: String,
    password: String,
    database: String,
) -> Result<String, String> {
    validate_sql_fields(&auth_mode, &username, &password, &database)?;

    let runner = dotnet_runner_path();
    let output = Command::new(runner)
        .args(["test-sql", &instance, &auth_mode, &username, &password, &database])
        .output()
        .map_err(|e| format!("Failed to launch DotNetRunner: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Drops the K2 database, reversing test_sql_connection's database
/// creation. Same DotNetRunner spawn pattern, just a different command.
#[tauri::command]
pub fn drop_k2_database(
    instance: String,
    auth_mode: String,
    username: String,
    password: String,
    database: String,
) -> Result<String, String> {
    validate_sql_fields(&auth_mode, &username, &password, &database)?;

    let runner = dotnet_runner_path();
    let output = Command::new(runner)
        .args(["drop-database", &instance, &auth_mode, &username, &password, &database])
        .output()
        .map_err(|e| format!("Failed to launch DotNetRunner: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Looks up the K2 service account and administrators group in Active
/// Directory (read-only, via DotNetRunner's ad-check command). This
/// deliberately never creates the group even when "Create this group in
/// AD if it does not exist" is checked, creating objects in a real
/// customer AD is a separate, explicit action this spike doesn't take
/// silently on a wizard step's Next click.
#[tauri::command]
pub fn check_ad_objects(
    service_account: String,
    admins_group: String,
    create_group_if_missing: bool,
) -> Result<String, String> {
    if service_account.trim().is_empty() {
        return Err("K2 service account cannot be empty.".to_string());
    }
    if admins_group.trim().is_empty() {
        return Err("K2 administrators group cannot be empty.".to_string());
    }

    let runner = dotnet_runner_path();
    let create_flag = if create_group_if_missing { "true" } else { "false" };
    let output = Command::new(runner)
        .args(["ad-check", &service_account, &admins_group, create_flag])
        .output()
        .map_err(|e| format!("Failed to launch DotNetRunner: {e}"))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
