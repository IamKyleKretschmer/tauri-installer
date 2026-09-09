use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

/// Runs an already-spawned child to completion (or until timeout, killing
/// it), returning its exit status and captured stdout/stderr.
///
/// This exists because `child.try_wait()` in a polling loop, followed by
/// `child.wait_with_output()`, deadlocks on any chatty child: Windows
/// pipes have a small fixed buffer (~64KB), and nothing drains stdout/
/// stderr while the poll loop is running - once a verbose child (like a
/// full K2 SetupManager /install run, thousands of trace lines) fills
/// that buffer, its next write blocks forever, the process never exits,
/// try_wait() never returns Some, and the poll loop just runs out the
/// clock waiting on a child that's actually stuck on us, not on
/// whatever it was doing. Real bug found by comparing this every one of
/// this project's earlier "hangs" against Task Manager (0% CPU the whole
/// time - a child truly blocked on I/O, not looping) across totally
/// different network conditions that should have behaved differently.
/// Draining stdout/stderr concurrently on their own threads, the whole
/// time the child runs, avoids this entirely.
#[cfg(target_os = "windows")]
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: Duration,
) -> Result<(std::process::ExitStatus, String, String), String> {
    use std::io::Read;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut buf);
        }
        buf
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Timed out after {}s", timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(200));
    };

    let stdout = stdout_thread.join().unwrap_or_default();
    let stderr = stderr_thread.join().unwrap_or_default();

    Ok((
        status,
        String::from_utf8_lossy(&stdout).trim().to_string(),
        String::from_utf8_lossy(&stderr).trim().to_string(),
    ))
}

// Generous: real mutating actions here (secedit, and especially
// configure_iis_site provisioning 14 web apps, since each
// WebAdministration cmdlet call is slow) can legitimately take
// several minutes, but nothing should be able to hang the app
// indefinitely. Every command in this file also runs its blocking work
// via tauri::async_runtime::spawn_blocking rather than on the command
// dispatch thread directly, so even hitting this timeout doesn't freeze
// the UI while waiting, unlike the freeze this was found from.
#[cfg(target_os = "windows")]
const POWERSHELL_TIMEOUT: Duration = Duration::from_secs(300);

/// Writes the install log to the current user's Desktop and returns the
/// full path. Content is passed over stdin rather than embedded in the
/// PowerShell script string, so arbitrary log text (quotes, newlines)
/// can't break out of the script.
#[tauri::command]
pub async fn write_install_log(contents: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use std::io::Write;
            use std::process::Stdio;

            let script = r#"
$content = [Console]::In.ReadToEnd()
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop ("K2-Setup-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd-HHmm'))
Set-Content -LiteralPath $path -Value $content -Encoding UTF8
$path
"#;
            let mut child = Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to launch PowerShell: {e}"))?;

            child
                .stdin
                .take()
                .ok_or("Failed to open PowerShell stdin")?
                .write_all(contents.as_bytes())
                .map_err(|e| format!("Failed to write log content: {e}"))?;

            let output = child
                .wait_with_output()
                .map_err(|e| format!("Failed to wait for PowerShell: {e}"))?;

            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() { stdout } else { stderr });
            }
            Ok(stdout)
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = contents;
            Err("Writing the install log requires Windows".to_string())
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch PowerShell: {e}"))?;

    let deadline = Instant::now() + POWERSHELL_TIMEOUT;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Timed out after {}s waiting for PowerShell", POWERSHELL_TIMEOUT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    let output = child.wait_with_output().map_err(|e| format!("Failed to wait for PowerShell: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(stdout)
}

#[cfg(not(target_os = "windows"))]
fn unsupported(action: &str) -> Result<String, String> {
    Err(format!("{action} requires Windows"))
}

/// The K2 web components that live as virtual applications under the main
/// K2 site, matching the layout shown in IIS Manager for a real K2 Five
/// install (each one its own web application with its own physical
/// folder under the K2 install's "Web Bin" directory, the same pattern as
/// the legacy Webservices\<Name> vdirs in SourceCode.Install.Web /
/// Configuration.config, just with the fuller K2 Five component list).
const K2_WEB_APPS: &[&str] = &[
    "Api",
    "aspnet_client",
    "AutoDiscover",
    "Designer",
    "Identity",
    "K2Api",
    "K2Services",
    "Management",
    "Report",
    "Runtime",
    "RuntimeServices",
    "SP15EventService",
    "ViewFlow",
    "Workspace",
];

/// Creates (or replaces) the K2 site in IIS along with the full tree of
/// web-component virtual applications underneath it (Management,
/// Designer, Runtime, etc, mirroring what SourceCode.Install.Web's
/// Website/Application/AppPool helpers build for a real K2 install).
/// Real, but scoped to just this one site name and its own app pools;
/// removing them is how you undo it.
#[tauri::command]
pub async fn configure_iis_site(
    site_name: String,
    http_port: String,
    https_port: String,
    app_pool_identity: String,
    certificate_thumbprint: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let identity_value = match app_pool_identity.as_str() {
            "NetworkService" => "NetworkService",
            "ApplicationPoolIdentity" => "ApplicationPoolIdentity",
            // No credential fields exist yet for a genuine custom account,
            // so fall back to the safe default rather than guessing one.
            _ => "ApplicationPoolIdentity",
        };

        let web_apps_list = K2_WEB_APPS.join(",");

        let script = format!(
            r#"
Import-Module WebAdministration -ErrorAction Stop
$site = '{site_name}'
$httpPort = {http_port}
$httpsPort = {https_port}
$identity = '{identity_value}'
$thumbprint = '{certificate_thumbprint}'
$webApps = '{web_apps_list}' -split ','

if (Get-Website -Name $site -ErrorAction SilentlyContinue) {{ Remove-Website -Name $site }}
if (Test-Path "IIS:\AppPools\$site") {{ Remove-WebAppPool -Name $site }}

New-WebAppPool -Name $site | Out-Null
Set-ItemProperty "IIS:\AppPools\$site" -Name processModel.identityType -Value $identity
Set-ItemProperty "IIS:\AppPools\$site" -Name managedPipelineMode -Value Classic

$sitePhysicalPath = "$env:ProgramFiles\K2\WebServices"
New-Item -ItemType Directory -Force -Path $sitePhysicalPath | Out-Null
New-Website -Name $site -Port $httpPort -PhysicalPath $sitePhysicalPath -ApplicationPool $site -Force | Out-Null

foreach ($app in $webApps) {{
    $appPoolName = "$site $app"
    if (-not (Test-Path "IIS:\AppPools\$appPoolName")) {{
        New-WebAppPool -Name $appPoolName | Out-Null
        Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name processModel.identityType -Value $identity
        # K2's ApplicationPoolPipelineMode checklist task requires Classic,
        # not IIS's own default of Integrated.
        Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name managedPipelineMode -Value Classic
    }}
    $appPhysicalPath = Join-Path $sitePhysicalPath $app
    New-Item -ItemType Directory -Force -Path $appPhysicalPath | Out-Null
    if (Get-WebApplication -Site $site -Name $app -ErrorAction SilentlyContinue) {{
        Remove-WebApplication -Site $site -Name $app
    }}
    New-WebApplication -Site $site -Name $app -PhysicalPath $appPhysicalPath -ApplicationPool $appPoolName | Out-Null
}}

if ($httpsPort -gt 0) {{
    New-WebBinding -Name $site -Protocol https -Port $httpsPort -ErrorAction SilentlyContinue | Out-Null
    if ($thumbprint) {{
        $binding = Get-WebBinding -Name $site -Protocol https
        $binding.AddSslCertificate($thumbprint, "my")
    }}
}}

"Site '$site' created on ports $httpPort/$httpsPort with $($webApps.Count) K2 web applications and app pool identity $identity"
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (site_name, http_port, https_port, app_pool_identity, certificate_thumbprint);
        unsupported("Configuring the IIS site")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Mirrors the real legacy SourceCode.Install.Package.Actions.IO.CopyFiles
/// action: for a given Source/Target pair, create the target folder,
/// recreate the source's subdirectory structure under it, then copy
/// every file across (overwriting same-named files), skipping cleanly
/// (not failing) when the source folder doesn't exist. The real
/// installer runs one CopyFiles action per component target (host
/// server, each web application, ...); this does the same, driven by
/// the caller's source root being laid out with a "HostServer" folder
/// and one folder per K2 web app matching K2_WEB_APPS.
///
/// Expects `source_root` to contain, if present:
///   HostServer\...                  -> Program Files\K2\Host Server\Bin
///   <AppName>\...  (per K2_WEB_APPS) -> Program Files\K2\WebServices\<AppName>
/// (matching the real, flat C:\Program Files\K2\WebServices layout
/// confirmed against an actual K2 install, not a nested "Web Bin"
/// folder). If no source root is given, or none of those subfolders
/// exist, this
/// reports a clean skip rather than failing, since a bare spike install
/// may not have the real product payload available yet.
#[tauri::command]
pub async fn copy_k2_files(source_root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        if source_root.trim().is_empty() {
            return Ok("No K2 source files folder was provided, skipping file deployment".to_string());
        }

        let web_apps_list = K2_WEB_APPS.join(",");

        let script = format!(
            r#"
$sourceRoot = '{source_root}'
if (-not (Test-Path -LiteralPath $sourceRoot)) {{ throw "Source files folder not found: $sourceRoot" }}

function Copy-K2Folder($source, $target) {{
    if (-not (Test-Path -LiteralPath $source)) {{ return 0 }}
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem -LiteralPath $source -Recurse -Directory | ForEach-Object {{
        $rel = $_.FullName.Substring($source.Length).TrimStart('\')
        New-Item -ItemType Directory -Force -Path (Join-Path $target $rel) | Out-Null
    }}
    $count = 0
    Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object {{
        $rel = $_.FullName.Substring($source.Length).TrimStart('\')
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $rel) -Force
        $count++
    }}
    return $count
}}

$webRoot = "$env:ProgramFiles\K2\WebServices"
$hostRoot = "$env:ProgramFiles\K2\Host Server\Bin"
$totalCopied = 0

$totalCopied += Copy-K2Folder (Join-Path $sourceRoot "HostServer") $hostRoot

$webApps = '{web_apps_list}' -split ','
foreach ($app in $webApps) {{
    $totalCopied += Copy-K2Folder (Join-Path $sourceRoot $app) (Join-Path $webRoot $app)
}}

if ($totalCopied -eq 0) {{
    "No matching HostServer or web app folders found under $sourceRoot, nothing copied"
}} else {{
    "Copied $totalCopied file(s) from $sourceRoot"
}}
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = source_root;
        unsupported("Copying K2 files")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Drops a minimal placeholder page into any K2 web app folder that came
/// out of copy_k2_files still empty (no real K2 payload was available),
/// so that browsing to that app's IIS URL after install resolves to a
/// real, identifiable page instead of a blank folder listing or 404.
/// Never overwrites a folder that already has real content in it.
#[tauri::command]
pub async fn scaffold_k2_placeholder_pages() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let web_apps_list = K2_WEB_APPS.join(",");

        let script = format!(
            r#"
$webRoot = "$env:ProgramFiles\K2\WebServices"
$webApps = '{web_apps_list}' -split ','
$scaffolded = 0

foreach ($app in $webApps) {{
    $dir = Join-Path $webRoot $app
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $hasFiles = (Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    if (-not $hasFiles) {{
        $html = @"
<!DOCTYPE html>
<html>
<head>
<title>K2 $app</title>
<style>
body {{ font-family: 'Segoe UI', Arial, sans-serif; background: #0a0e27; color: #fff; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }}
.card {{ background: #141a3d; border: 1px solid #2f5fdb; border-radius: 12px; padding: 2.5rem 3rem; text-align: center; max-width: 420px; }}
h1 {{ color: #ff6a3d; margin: 0 0 0.5rem; }}
p {{ color: #9aa3c9; margin: 0.4rem 0; }}
</style>
</head>
<body>
<div class="card">
<h1>K2 $app</h1>
<p>This is a placeholder page deployed by the K2 Setup POC installer.</p>
<p>Real K2 $app content was not provided for this install.</p>
</div>
</body>
</html>
"@
        Set-Content -LiteralPath (Join-Path $dir "Default.htm") -Value $html -Encoding UTF8
        $scaffolded++
    }}
}}

"Scaffolded placeholder pages for $scaffolded of $($webApps.Count) K2 web application(s)"
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Scaffolding K2 placeholder pages")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Removes the K2 site, its own app pool, and every K2 web application
/// app pool created by configure_iis_site. Leaves the physical files on
/// disk untouched (only the IIS configuration is reverted); scoped to
/// just this one site name and its own app pools, same as
/// configure_iis_site is scoped when creating them.
#[tauri::command]
pub async fn remove_iis_site(site_name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let web_apps_list = K2_WEB_APPS.join(",");

        let script = format!(
            r#"
Import-Module WebAdministration -ErrorAction Stop
$site = '{site_name}'
$webApps = '{web_apps_list}' -split ','
$removed = 0

if (Get-Website -Name $site -ErrorAction SilentlyContinue) {{
    Remove-Website -Name $site
    $removed++
}}

foreach ($app in $webApps) {{
    $appPoolName = "$site $app"
    if (Test-Path "IIS:\AppPools\$appPoolName") {{
        Remove-WebAppPool -Name $appPoolName
        $removed++
    }}
}}

if (Test-Path "IIS:\AppPools\$site") {{
    Remove-WebAppPool -Name $site
    $removed++
}}

"Removed site '$site' and $($removed - 1) associated app pool(s)"
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = site_name;
        unsupported("Removing the IIS site")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Disables TLS 1.0 and 1.1 for both Client and Server roles via the
/// Schannel registry keys. Machine-wide: affects every app/service on
/// this box, not just K2, and typically needs a reboot to fully take
/// effect for other already-running services.
#[tauri::command]
pub async fn disable_legacy_tls() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$protocols = 'TLS 1.0', 'TLS 1.1'
$roles = 'Client', 'Server'
foreach ($protocol in $protocols) {
    foreach ($role in $roles) {
        $key = "HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\$protocol\$role"
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name 'Enabled' -Value 0 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name 'DisabledByDefault' -Value 1 -PropertyType DWord -Force | Out-Null
    }
}
"TLS 1.0 and 1.1 disabled for Client and Server (registry updated, a reboot may be required for other services to pick this up)"
"#;
        run_powershell(script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Disabling TLS 1.0/1.1")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Reverses disable_legacy_tls: re-enables TLS 1.0 and 1.1 for both
/// Client and Server roles via the same Schannel registry keys.
/// Machine-wide, same caveat as the original action.
#[tauri::command]
pub async fn restore_legacy_tls() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$protocols = 'TLS 1.0', 'TLS 1.1'
$roles = 'Client', 'Server'
foreach ($protocol in $protocols) {
    foreach ($role in $roles) {
        $key = "HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\$protocol\$role"
        New-Item -Path $key -Force | Out-Null
        New-ItemProperty -Path $key -Name 'Enabled' -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name 'DisabledByDefault' -Value 0 -PropertyType DWord -Force | Out-Null
    }
}
"TLS 1.0 and 1.1 re-enabled for Client and Server (registry updated, a reboot may be required for other services to pick this up)"
"#;
        run_powershell(script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Restoring TLS 1.0/1.1")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Grants the given account the "Log on as a service" local security
/// policy right (SeServiceLogonRight), via the standard secedit
/// export/edit/import approach (there is no direct PowerShell cmdlet for
/// user rights assignment). Scoped to just this one right for this one
/// account; removing the account from that policy undoes it.
#[tauri::command]
pub async fn grant_service_logon_right(account: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"
$account = '{account}'
$sid = (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$cfgPath = Join-Path $env:TEMP "k2-secedit-$([guid]::NewGuid().ToString('N')).cfg"
$dbPath = Join-Path $env:TEMP "k2-secedit-$([guid]::NewGuid().ToString('N')).sdb"

secedit /export /cfg $cfgPath /areas USER_RIGHTS | Out-Null
$content = Get-Content $cfgPath

$existingLine = $content | Select-String '^SeServiceLogonRight'
if ($existingLine) {{
    if ($existingLine.Line -notmatch [regex]::Escape($sid)) {{
        $newLine = $existingLine.Line + ",*$sid"
        $content = $content -replace [regex]::Escape($existingLine.Line), $newLine
    }}
}} else {{
    $content += "SeServiceLogonRight = *$sid"
}}
$content | Set-Content $cfgPath

secedit /configure /db $dbPath /cfg $cfgPath /areas USER_RIGHTS | Out-Null
Remove-Item $cfgPath, $dbPath -ErrorAction SilentlyContinue

"Granted 'Log on as a service' to $account"
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = account;
        unsupported("Granting the service logon right")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Reverses grant_service_logon_right: removes the given account's SID
/// from the SeServiceLogonRight local security policy line, via the
/// same secedit export/edit/import round-trip. Leaves the right intact
/// for any other accounts already granted it.
#[tauri::command]
pub async fn revoke_service_logon_right(account: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"
$account = '{account}'
$sid = (New-Object System.Security.Principal.NTAccount($account)).Translate([System.Security.Principal.SecurityIdentifier]).Value
$cfgPath = Join-Path $env:TEMP "k2-secedit-$([guid]::NewGuid().ToString('N')).cfg"
$dbPath = Join-Path $env:TEMP "k2-secedit-$([guid]::NewGuid().ToString('N')).sdb"

secedit /export /cfg $cfgPath /areas USER_RIGHTS | Out-Null
$content = Get-Content $cfgPath

$existingLine = $content | Select-String '^SeServiceLogonRight'
if ($existingLine) {{
    $members = $existingLine.Line -replace '^SeServiceLogonRight\s*=\s*', ''
    $remaining = ($members -split ',') | Where-Object {{ $_ -notmatch [regex]::Escape($sid) }}
    $newLine = "SeServiceLogonRight = " + ($remaining -join ',')
    $content = $content -replace [regex]::Escape($existingLine.Line), $newLine
}}
$content | Set-Content $cfgPath

secedit /configure /db $dbPath /cfg $cfgPath /areas USER_RIGHTS | Out-Null
Remove-Item $cfgPath, $dbPath -ErrorAction SilentlyContinue

"Revoked 'Log on as a service' from $account"
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = account;
        unsupported("Revoking the service logon right")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Clears stale "K2 ..."/"Nintex Automation K2 ..." entries from the
/// Windows uninstall registry (both native and Wow6432Node views).
///
/// The real SetupManager decides whether a component like "K2 Database"
/// needs a fresh install or just a repair by checking whether a product
/// matching its name is already registered here - the same data Control
/// Panel's "Programs and Features" reads. Our own Remove flow only tears
/// down the IIS site, SQL database, TLS registry keys and AD logon right;
/// it never removes this registration. So on a repeat configure attempt,
/// the real installer still sees e.g. "K2 Database (5.0011.1000.0)" as
/// installed (confirmed via a real InstallerTrace log:
/// "InstallChecker.IsProductInstalledfromNamePart: K2 Database installed:
/// True"), treats the run as a repair, and skips re-deploying the K2
/// database schema onto the fresh, empty database we just recreated -
/// which is why later steps fail with "Invalid object name" against
/// tables (CustomUM.User, Identity.Identity, HostServer.Application, ...)
/// that were never actually created.
#[tauri::command]
pub async fn remove_k2_product_registrations() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$paths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$removed = @()
$failures = @()
foreach ($path in $paths) {
    Get-ItemProperty -Path $path -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.DisplayName
        if ($name -and ($name -like 'K2*' -or $name -like 'Nintex Automation K2*')) {
            try {
                Remove-Item -Path $_.PSPath -Recurse -Force -ErrorAction Stop
                $removed += $name
            } catch {
                $failures += "$name ($($_.Exception.Message))"
            }
        }
    }
}
if ($failures.Count -gt 0) {
    throw "Failed to remove $($failures.Count) K2 product registration(s): $($failures -join '; ')"
}
if ($removed.Count -eq 0) {
    "No K2 product registrations found, nothing to remove"
} else {
    "Removed $($removed.Count) stale K2 product registration(s): $($removed -join ', ')"
}
"#;
        run_powershell(script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Removing K2 product registrations")
    }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Local build folder the POC downloads/extracts into, mirroring the
/// FullBuild folder AutomateK2Install_v4.7.ps1's Initialize-Download /
/// Initialize-Extract create under the K2 support share.
fn build_folder() -> PathBuf {
    std::env::temp_dir().join("K2InstallBuild")
}

/// Real download step, standing in for AutomateK2Install_v4.7.ps1's
/// Initialize-Download (which pulls a version-specific installer package
/// from K2's own CDN). We don't have a real K2 CDN URL or license to hit,
/// so this fetches whatever package source the wizard is given instead:
/// an http(s) URL is actually downloaded over the network, a local path
/// is actually copied. Either way the file that lands in the build
/// folder is real, not simulated.
#[tauri::command]
pub async fn download_k2_package(package_source: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_dir = build_folder();
        std::fs::create_dir_all(&dest_dir).map_err(|e| format!("Failed to create build folder: {e}"))?;

        let file_name = package_source
            .rsplit(['/', '\\'])
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or("k2-package.zip");
        let dest_path = dest_dir.join(file_name);

        if package_source.starts_with("http://") || package_source.starts_with("https://") {
            let response = reqwest::blocking::get(&package_source)
                .map_err(|e| format!("Download failed: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Download failed: {e}"))?;
            let bytes = response.bytes().map_err(|e| format!("Failed to read download: {e}"))?;
            let mut file = File::create(&dest_path).map_err(|e| format!("Failed to write {}: {e}", dest_path.display()))?;
            file.write_all(&bytes).map_err(|e| format!("Failed to write {}: {e}", dest_path.display()))?;
            Ok(format!(
                "{}|Downloaded {} bytes to {}",
                dest_path.display(),
                bytes.len(),
                dest_path.display()
            ))
        } else {
            let source_path = PathBuf::from(&package_source);
            if !source_path.is_file() {
                return Err(format!("Package not found: {}", source_path.display()));
            }
            let bytes = std::fs::copy(&source_path, &dest_path)
                .map_err(|e| format!("Failed to copy {}: {e}", source_path.display()))?;
            Ok(format!("{}|Copied {} bytes to {}", dest_path.display(), bytes, dest_path.display()))
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Real extract step, standing in for Initialize-Extract's
/// `Start-Process ... -ArgumentList "-y -gm2 -nr"` self-extraction. Uses
/// the `zip` crate to actually unpack the downloaded/copied archive into
/// the build folder's Extracted subdirectory (matching the real script's
/// "...\Installation" layout it then Set-Location's into).
#[tauri::command]
pub async fn extract_k2_package(archive_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let archive_path = PathBuf::from(archive_path);
        let file = File::open(&archive_path).map_err(|e| format!("Failed to open {}: {e}", archive_path.display()))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Not a valid zip package: {e}"))?;

        let extract_dir = build_folder().join("Extracted");
        std::fs::create_dir_all(&extract_dir).map_err(|e| format!("Failed to create {}: {e}", extract_dir.display()))?;

        let count = archive.len();
        archive
            .extract(&extract_dir)
            .map_err(|e| format!("Extraction failed: {e}"))?;

        Ok(format!("{}|Extracted {} entries to {}", extract_dir.display(), count, extract_dir.display()))
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Real installer invocation, standing in for AutomateK2Install_v4.7.ps1's
/// Initialize-Install (`.\SourceCode.SetupManager.exe /install:"$_silentXml"
/// /noval`) / Initialize-Install47 (`.\Setup.exe /install:"$_pearl"`).
/// installation_folder must be a real, already-extracted K2 build's
/// "Installation" folder (containing one of those two exe names);
/// silent_xml_contents is the answer file this run writes to a temp file
/// and passes via /install:<path>. Generous timeout since a real K2
/// install genuinely can take upwards of 20-30 minutes.
#[cfg(target_os = "windows")]
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(1800);

#[cfg(target_os = "windows")]
fn find_setup_exe(folder: &std::path::Path) -> Result<PathBuf, String> {
    ["SourceCode.SetupManager.exe", "Setup.exe"]
        .iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            format!(
                "Neither SourceCode.SetupManager.exe nor Setup.exe was found in {}",
                folder.display()
            )
        })
}

#[tauri::command]
pub async fn run_real_installer(installation_folder: String, silent_xml_contents: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let folder = PathBuf::from(&installation_folder);
            let exe_path = find_setup_exe(&folder)?;

            let xml_path = std::env::temp_dir().join("k2-silent-install.xml");
            std::fs::write(&xml_path, &silent_xml_contents)
                .map_err(|e| format!("Failed to write answer file {}: {e}", xml_path.display()))?;

            let mut child = Command::new(&exe_path)
                .current_dir(&folder)
                .arg(format!("/install:{}", xml_path.display()))
                .arg("/noval")
                // /noval only disables SetupManager's general answer-file
                // validation - the encryption-reconciliation check behind
                // "EncryptionValidation: Unable to validate encryption" is
                // a separate opt-in (ConnectionEncryptionValidation, real
                // source: CommandDefinition.cs), only satisfied by this
                // flag. Real automation script uses the same flag on its
                // /upgrade path (Initialize-Update).
                .arg("/UpdateConnectionEncryption")
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to launch {}: {e}", exe_path.display()))?;

            let (status, stdout, stderr) = wait_with_timeout(child, INSTALLER_TIMEOUT)
                .map_err(|e| format!("{e} waiting for the real installer"))?;

            if !status.success() {
                let detail = if stderr.is_empty() { stdout } else { stderr };
                return Err(format!("Installer exited with {status}: {detail}"));
            }

            Ok(format!(
                "Ran {} against {} - exited {}. {}",
                exe_path.display(),
                xml_path.display(),
                status,
                if stdout.is_empty() { "(no output)".to_string() } else { stdout }
            ))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (installation_folder, silent_xml_contents);
            unsupported("Running the real K2 installer")
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Real machine-key retrieval, standing in for AutomateK2Install_v4.7.ps1's
/// Get-MachineKey (`&.\SourceCode.SetupManager.exe /noui /systemkey`).
/// Run from the same real installation_folder used for run_real_installer,
/// so the wizard never needs the operator to run this by hand and paste
/// the result in - this can just be run fresh on whatever machine is
/// actually doing the install.
#[cfg(target_os = "windows")]
const SYSTEMKEY_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(target_os = "windows")]
fn extract_system_key(output: &str) -> Option<String> {
    let marker = "System key:";
    let after_marker = &output[output.find(marker)? + marker.len()..];
    let quote_start = after_marker.find('\'')? + 1;
    let quote_end = after_marker[quote_start..].find('\'')?;
    let key = after_marker[quote_start..quote_start + quote_end].trim();
    if key.is_empty() { None } else { Some(key.to_string()) }
}

#[tauri::command]
pub async fn get_machine_key(installation_folder: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let folder = PathBuf::from(&installation_folder);
            let exe_path = find_setup_exe(&folder)?;

            let mut child = Command::new(&exe_path)
                .current_dir(&folder)
                .args(["/noui", "/systemkey"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to launch {}: {e}", exe_path.display()))?;

            let (status, stdout, stderr) = wait_with_timeout(child, SYSTEMKEY_TIMEOUT)
                .map_err(|e| format!("{e} waiting for /systemkey"))?;

            if !status.success() {
                let detail = if stderr.is_empty() { stdout } else { stderr };
                return Err(format!("{} exited with {status}: {detail}", exe_path.display()));
            }
            if stdout.is_empty() {
                return Err(format!(
                    "{} produced no output for /noui /systemkey - this build may use a different switch, or may need to run elevated",
                    exe_path.display()
                ));
            }

            // /noui /systemkey doesn't print just the key - it prints its
            // whole verbose trace (loading license assemblies, log file
            // path, etc), with the actual key embedded as a line like
            // `!System key: 'D2037824B3F1472E'`. Passing the raw blob
            // through as MACHINEKEY is invalid input to the real
            // installer's encryption validation, so pull just the quoted
            // value out of it.
            match extract_system_key(&stdout) {
                Some(key) => Ok(key),
                None => Err(format!(
                    "Could not find a \"System key: '...'\" line in {}'s /systemkey output: {stdout}",
                    exe_path.display()
                )),
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = installation_folder;
            unsupported("Retrieving the machine key")
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Looks for a real, already-extracted K2 build so the operator doesn't
/// have to type its path in - searches the current user's Desktop and
/// Downloads folders (where a manually-downloaded/extracted build like
/// "Nintex Automation K2 (5.10) (...)\Installation" typically lands),
/// a few levels deep, for a folder containing SourceCode.SetupManager.exe
/// or Setup.exe. Returns the first match, or None if nothing is found -
/// that's the normal case on most machines, not an error.
#[cfg(target_os = "windows")]
fn search_for_setup_exe(dir: &std::path::Path, remaining_depth: u32) -> Option<PathBuf> {
    if remaining_depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join("SourceCode.SetupManager.exe").is_file() || path.join("Setup.exe").is_file() {
            return Some(path);
        }
        subdirs.push(path);
    }
    for subdir in subdirs {
        if let Some(found) = search_for_setup_exe(&subdir, remaining_depth - 1) {
            return Some(found);
        }
    }
    None
}

#[tauri::command]
pub async fn find_installation_folder() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let Some(home) = std::env::var_os("USERPROFILE") else {
                return Ok(None);
            };
            let home = PathBuf::from(home);

            for root in [home.join("Desktop"), home.join("Downloads")] {
                if let Some(found) = search_for_setup_exe(&root, 4) {
                    return Ok(Some(found.to_string_lossy().to_string()));
                }
            }
            Ok(None)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Ok(None)
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}
