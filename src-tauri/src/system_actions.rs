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
    hostname: String,
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

        // Same cleanup k2SilentInstall.ts's cleanHostname does: a bare host
        // (or empty, from a dev/no-hostname run) - never a URL. Real
        // evidence: without a host header on the bindings at all, IIS's own
        // "Browse Application" panel falls back to generic "*:80 (http)" /
        // "*:443 (https)" links instead of a real "Browse <host> on :443"
        // one, which is also what a customer machine's site never starting
        // under its real name looked like - the site itself still worked,
        // but nothing pointed a browser (or K2's own site-URL config) at
        // the actual hostname it expects to be reachable on.
        let clean_hostname = hostname.trim().trim_start_matches("http://").trim_start_matches("https://").trim_end_matches('/');
        let host_header = if clean_hostname.is_empty() || clean_hostname.eq_ignore_ascii_case("localhost") {
            String::new()
        } else {
            clean_hostname.to_string()
        };

        let script = format!(
            r#"
Import-Module WebAdministration -ErrorAction Stop
$site = '{site_name}'
$httpPort = {http_port}
$httpsPort = {https_port}
$identity = '{identity_value}'
$thumbprint = '{certificate_thumbprint}'
$hostHeader = '{host_header}'
$webApps = '{web_apps_list}' -split ','

if (Get-Website -Name $site -ErrorAction SilentlyContinue) {{ Remove-Website -Name $site }}
if (Test-Path "IIS:\AppPools\$site") {{ Remove-WebAppPool -Name $site }}

New-WebAppPool -Name $site | Out-Null
Set-ItemProperty "IIS:\AppPools\$site" -Name processModel.identityType -Value $identity
Set-ItemProperty "IIS:\AppPools\$site" -Name managedPipelineMode -Value Classic

$sitePhysicalPath = "$env:ProgramFiles\K2\WebServices"
New-Item -ItemType Directory -Force -Path $sitePhysicalPath | Out-Null
# A freshly created folder only inherits C:\Program Files\K2's own ACL,
# which never includes IIS_IUSRS (every ApplicationPoolIdentity app pool's
# implicit membership at runtime) the way a real inetpub content folder
# would - without this, the app pool can run the site but not read its own
# web.config once K2's real files land here ("500.19 ... insufficient
# permissions").
icacls $sitePhysicalPath /grant "IIS_IUSRS:(OI)(CI)RX" /T /C | Out-Null
New-Website -Name $site -Port $httpPort -HostHeader $hostHeader -PhysicalPath $sitePhysicalPath -ApplicationPool $site -Force | Out-Null

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
    New-WebBinding -Name $site -Protocol https -Port $httpsPort -HostHeader $hostHeader -ErrorAction SilentlyContinue | Out-Null
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
        let _ = (site_name, http_port, https_port, app_pool_identity, certificate_thumbprint, hostname);
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

/// Real root cause, confirmed on a live run: K2's own component validator
/// (Executor.ValidateComponentPrereqsAndValidators) refuses to configure the
/// JSSP service with "Low trust user is required as a service account for
/// the JSSP service" whenever the account is a member of the local
/// Administrators group on this machine - independent of its AD group
/// memberships, which can be perfectly ordinary. Since this account got
/// added to local Administrators at some point between install attempts
/// (not something the vendor package itself does), and the wizard reuses
/// the same account for JSSP as everything else, this strips that
/// membership before every real install run so the validator sees a
/// genuinely low-trust account every time, not just on the first attempt.
/// A no-op (not a failure) if the account was never a member.
#[tauri::command]
pub async fn remove_local_admin_membership(account: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let child = Command::new("net")
                .args(["localgroup", "administrators", &account, "/delete"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Failed to launch net.exe: {e}"))?;

            let output = child.wait_with_output().map_err(|e| format!("Failed to wait for net.exe: {e}"))?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

            // "The specified account name is not a member of the group" (net
            // error 2237/1377 depending on Windows version) just means it
            // was already not a local admin - that's the desired end state,
            // not a failure this action should report.
            let combined = format!("{stdout} {stderr}");
            if output.status.success() || combined.to_lowercase().contains("not a member") {
                Ok(format!("{account} is not a member of the local Administrators group"))
            } else {
                Err(if stderr.is_empty() { stdout } else { stderr })
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = account;
            unsupported("Removing local Administrators membership")
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// Clears stale K2 product registrations that make the real SetupManager
/// think components like "K2 Database" are already installed, so a repeat
/// Configure treats the run as a repair and skips re-deploying the K2
/// database schema onto the fresh, empty database we just recreated -
/// which is why later steps fail with "Invalid object name" against
/// tables (CustomUM.User, Identity.Identity, HostServer.Application, ...)
/// that were never actually created.
///
/// Confirmed via a real machine's registry (not a guess): the plain
/// "Programs and Features" Uninstall keys were NOT the source - those were
/// empty in both HKLM and HKCU, and `Win32_Product` (true MSI enumeration)
/// found nothing either. The real registration turned out to be genuine
/// Windows Installer product data keyed by a compressed "Darwin
/// descriptor" form of the product GUID (byte-reordered, no dashes) under:
///   HKLM:\SOFTWARE\Classes\Installer\Products\<compressed-guid>
///   HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData\<SID>\Products\<compressed-guid>
/// (found under the SYSTEM SID, S-1-5-18, in the confirmed case, but any
/// SID's UserData is checked here since it could be a per-user install
/// on a different machine). ProductName in these keys still reads e.g.
/// "K2 Database (5.0011.1000.0)", matching InstallChecker's own check.
#[tauri::command]
pub async fn remove_k2_product_registrations() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$removed = @()
$failures = @()

function Remove-MatchedKey($path) {
    try {
        Remove-Item -Path $path -Recurse -Force -ErrorAction Stop
        return $true
    } catch {
        $script:failures += "$path ($($_.Exception.Message))"
        return $false
    }
}

# Plain "Programs and Features" Uninstall entries, if present.
$uninstallPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($path in $uninstallPaths) {
    Get-ItemProperty -Path $path -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.DisplayName
        if ($name -and ($name -like 'K2*' -or $name -like 'Nintex Automation K2*')) {
            if (Remove-MatchedKey $_.PSPath) { $removed += $name }
        }
    }
}

# Real Windows Installer product registrations, keyed by compressed
# "Darwin descriptor" product codes rather than the friendly GUID text.
$installerProductRoots = @(
    'HKLM:\SOFTWARE\Classes\Installer\Products\*',
    'HKLM:\SOFTWARE\WOW6432Node\Classes\Installer\Products\*'
)
foreach ($path in $installerProductRoots) {
    Get-ItemProperty -Path $path -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.ProductName
        if ($name -and ($name -like 'K2*' -or $name -like 'Nintex Automation K2*')) {
            if (Remove-MatchedKey $_.PSPath) { $removed += $name }
        }
    }
}

# Per-SID UserData registrations (InstallProperties etc.) are scanned and
# matched independently by their own ProductName, rather than relying on
# codes found above - these two registrations don't always exist or get
# cleaned up together, and InstallChecker can read either one directly.
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\UserData' -ErrorAction SilentlyContinue | ForEach-Object {
    $productsPath = Join-Path $_.PSPath 'Products\*\InstallProperties'
    Get-ItemProperty -Path $productsPath -ErrorAction SilentlyContinue | ForEach-Object {
        $name = $_.DisplayName
        if ($name -and ($name -like 'K2*' -or $name -like 'Nintex Automation K2*')) {
            $productKeyPath = Split-Path $_.PSPath
            if (Remove-MatchedKey $productKeyPath) { $removed += $name }
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
/// and passes via /install:<path>.
///
/// Real trace log evidence (InstallerTrace260914_2/_3, once the
/// K2HOSTCONNECTIONSTRING fix let the install get past Management.kspx):
/// a genuine end-to-end K2 Server + Site install runs for 60-90+ minutes.
/// The previous 1800s (30 min) value was itself the root cause of an
/// earlier, seemingly inexplicable failure - "APICommunicationException:
/// ... An existing connection was forcibly closed by the remote host" /
/// HostServerEngine.StopHostServer() firing mid-deploy - because
/// wait_with_timeout force-kills the whole SourceCode.SetupManager.exe
/// process tree the instant this elapses, abruptly severing whatever
/// connection/service-management operation it had in flight against K2
/// Server at that moment. Confirmed directly by a later run's own status
/// message: "Timed out after 1800s waiting for the real installer".
#[cfg(target_os = "windows")]
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(10800);

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

/// Real evidence: SetupManager's own "Version Conflict" dialog fires
/// whenever it's run from anywhere OTHER than its own installed location
/// (`C:\Program Files\K2\Setup\...`) against a machine with real installed
/// state - independent of the database, Windows services, or registry
/// (all confirmed clean in a real run that still hit this). Clicking its
/// "Launch" button doesn't continue the process we spawned - it spawns a
/// brand-new, detached SetupManager.exe from the installed location and
/// lets ours exit, which we'd have no visibility into at all
/// (Global.LaunchInstalledSetupManager in a real trace log). Once a real
/// K2 component has actually been installed once, running from the
/// installed-location copy directly - exactly what the dialog itself
/// asks for - avoids the whole prompt and the untracked child process.
fn resolve_setup_exe(extracted_folder: &std::path::Path) -> Result<PathBuf, String> {
    let installed_location = PathBuf::from(r"C:\Program Files\K2\Setup\SourceCode.SetupManager.exe");
    if installed_location.is_file() {
        return Ok(installed_location);
    }
    find_setup_exe(extracted_folder)
}

/// The real SetupManager persists its own per-target completion journal
/// to disk at `INSTALLDIR\Setup\InstallHistoryRepository.ihr` (plus a
/// timestamped snapshot per run under `INSTALLDIR\Setup\State\`), rewriting
/// it after every single run regardless of success or failure. Confirmed
/// via a real machine: a target that never actually executed still logs
/// "Target already ran, skipping." on a later run once this file exists,
/// because it's used as a resume/journal mechanism independent of the
/// Windows registry (SetupManager keeps it even after we clear every
/// registry-based "is K2 installed" marker). Since this app always wants a
/// genuinely fresh attempt rather than a real incremental resume, this
/// clears it before every real install run.
#[cfg(target_os = "windows")]
fn clear_install_history_journal() {
    let setup_dir = PathBuf::from(r"C:\Program Files\K2\Setup");
    let _ = std::fs::remove_file(setup_dir.join("InstallHistoryRepository.ihr"));
    let _ = std::fs::remove_dir_all(setup_dir.join("State"));
}

/// Real root cause, confirmed via trace log: before the answer file set a
/// real K2SITENAME token, K2's own "K2 Workspace - Create K2 Workspace
/// Site" target used the literal unresolved "[K2SITENAME]" text (brackets
/// included) as the site name it passed to IIS, leaving a genuine, broken
/// IIS site by that literal name on disk from any run made before that fix
/// shipped. Confirmed via a real IIS Manager screenshot: it's still there
/// (alongside a working "K2" site) on a machine that had run this
/// installer before. A leftover site can hold a binding on the same
/// IP/port the real "K2" site needs, which is consistent with K2 site
/// failing to start in IIS afterward ("another site may be using the same
/// port"). Since every run now always sets a real K2SITENAME value, any
/// site actually named "[K2SITENAME]" can only be this stale leftover -
/// safe to remove unconditionally before each run rather than requiring
/// every affected operator to notice and delete it by hand in IIS Manager.
#[cfg(target_os = "windows")]
fn remove_stale_bracketed_workspace_site() {
    // -LiteralPath, not Test-Path's default wildcard-aware matching: the
    // IIS: PSDrive is a wildcard-capable provider like the filesystem one,
    // so a plain `Test-Path 'IIS:\AppPools\[K2SITENAME]'` treats the
    // brackets as a character class (matches a single app pool literally
    // named "K", "2", "S", ... ) instead of the literal bracketed name -
    // meaning this check silently never found the real stale app pool.
    let script = r#"
Import-Module WebAdministration -ErrorAction SilentlyContinue
if (Get-Website -Name '[K2SITENAME]' -ErrorAction SilentlyContinue) {
    Remove-Website -Name '[K2SITENAME]'
}
if (Test-Path -LiteralPath 'IIS:\AppPools\[K2SITENAME]') {
    Remove-WebAppPool -Name '[K2SITENAME]'
}
"#;
    let _ = run_powershell(script);
}

/// Makes sure the real, correctly-named K2 site (and its app pools) are
/// actually running once the install is done. Real evidence: a customer
/// machine where the install itself reported success still had K2's site
/// refusing to start in IIS - consistent with a phantom "[K2SITENAME]"
/// site (see remove_stale_bracketed_workspace_site) having held the same
/// port binding for at least part of the run, which leaves the real site
/// in a Stopped state that a passing installer never revisits. Starting it
/// explicitly here, after any stale bracketed leftover is cleared, is the
/// only point in this flow that both knows the real site name and runs
/// unconditionally after the install finishes.
#[cfg(target_os = "windows")]
fn start_real_k2_site(site_name: &str) -> String {
    let script = format!(
        r#"
Import-Module WebAdministration -ErrorAction SilentlyContinue
$site = '{site_name}'
$results = @()
try {{
    if ((Get-Website -Name $site -ErrorAction SilentlyContinue).State -ne 'Started') {{
        Start-Website -Name $site
    }}
    $results += "Site '$site' state: $((Get-Website -Name $site).State)"
}} catch {{
    $results += "Failed to start site '$site': $_"
}}
Get-ChildItem IIS:\AppPools | Where-Object {{ $_.Name -like "$site*" }} | ForEach-Object {{
    try {{
        if ($_.State -ne 'Started') {{
            Start-WebAppPool -Name $_.Name
        }}
        $results += "App pool '$($_.Name)' state: $((Get-Item "IIS:\AppPools\$($_.Name)").State)"
    }} catch {{
        $results += "Failed to start app pool '$($_.Name)': $_"
    }}
}}
$results -join "`n"
"#
    );
    run_powershell(&script).unwrap_or_else(|e| format!("Failed to run site-start script: {e}"))
}

/// Real evidence: a browser hitting a genuinely running site/app still got
/// "HTTP Error 500.19 ... Cannot read configuration file due to
/// insufficient permissions" on `C:\Program Files\K2\WebServices\web.config`
/// (error code 0x80070005 - ACCESS_DENIED). configure_iis_site creates that
/// folder itself via a plain `New-Item -ItemType Directory`, which only
/// inherits whatever ACL `C:\Program Files\K2` already has - and unlike a
/// real IIS content folder under inetpub, that never includes IIS_IUSRS (the
/// group every ApplicationPoolIdentity app pool identity is transparently a
/// member of at runtime), so the app pool worker process can create/run the
/// site but can't actually read its own web.config once K2's real files land
/// there. Grants Read & Execute recursively so every K2 web app under the
/// site (not just whichever one happened to be requested first) can read its
/// own config and content.
#[cfg(target_os = "windows")]
fn grant_iis_read_access_to_k2_webservices() -> String {
    let script = r#"
$path = "$env:ProgramFiles\K2\WebServices"
if (Test-Path -LiteralPath $path) {
    icacls $path /grant "IIS_IUSRS:(OI)(CI)RX" /T /C 2>&1 | Out-String
} else {
    "Skipped granting IIS_IUSRS read access: $path does not exist."
}
"#;
    run_powershell(script).unwrap_or_else(|e| format!("Failed to grant IIS_IUSRS access: {e}"))
}

/// Real root cause, confirmed against K2Services' own real web.config
/// (user-supplied) plus a real IIS "Add Roles and Features" screenshot
/// showing ".NET Framework 3.5 Features (Installed)": that Windows
/// feature registers a machine-wide web.config <sectionGroup
/// name="system.web.extensions"> (System.Web.Extensions ships its own
/// AJAX config registration at the machine level). K2Services' own
/// shipped web.config re-declares that exact same sectionGroup/section
/// for itself - harmless on a machine without .NET 3.5 installed, a hard
/// "duplicate section defined" conflict on one where it is, which is why
/// AppCmd fails every "K2 Workspace - Set K2Services ..." auth target
/// (Win Auth, useKernelMode, useAppPoolCredentials, anonymous auth, NTLM/
/// Negotiate providers) against this one file. SetupManager treats these
/// as non-fatal (still exits 0), so this app's own Err()-based retry
/// logic never sees them; the fix has to run as a real post-install
/// remediation instead - strip the redundant, already-machine-registered
/// sectionGroup from the file, then reapply the exact same auth settings
/// SetupManager tried (and failed) to set, directly via AppCmd.
#[cfg(target_os = "windows")]
fn fix_k2services_scripting_section_and_auth(site_name: &str) -> String {
    let mut notes: Vec<String> = Vec::new();
    let path = PathBuf::from(r"C:\Program Files\K2\WebServices\K2Services\web.config");

    match read_utf16le_file(&path) {
        Some(contents) => match strip_section_group(&contents, "system.web.extensions") {
            Some(fixed) => match write_utf16le_file(&path, &fixed) {
                Ok(()) => notes.push("K2Services fix: stripped duplicate system.web.extensions section.".to_string()),
                Err(e) => notes.push(format!("K2Services fix: found the duplicate section but failed to write it back: {e}")),
            },
            None => notes.push("K2Services fix: no system.web.extensions sectionGroup found in the file (nothing to strip).".to_string()),
        },
        None => notes.push(format!(
            "K2Services fix: could not read {} as UTF-16 (missing, or not the expected format).",
            path.display()
        )),
    }

    let app_path = format!("{site_name}/K2Services");
    let app_path = app_path.as_str();
    let commands: [&[&str]; 6] = [
        &[
            "set",
            "config",
            app_path,
            "/section:system.webServer/security/authentication/windowsAuthentication",
            "/enabled:true",
        ],
        &[
            "set",
            "config",
            app_path,
            "/section:system.webServer/security/authentication/windowsAuthentication",
            "/useKernelMode:true",
        ],
        &[
            "set",
            "config",
            app_path,
            "/section:system.webServer/security/authentication/windowsAuthentication",
            "/useAppPoolCredentials:true",
        ],
        &[
            "set",
            "config",
            app_path,
            "/section:system.webServer/security/authentication/anonymousAuthentication",
            "/enabled:true",
        ],
        &[
            "set",
            "config",
            app_path,
            "/section:system.webServer/security/authentication/windowsAuthentication",
            "/+providers.[value='NTLM']",
        ],
        &[
            "set",
            "config",
            app_path,
            "/section:system.webServer/security/authentication/windowsAuthentication",
            "/+providers.[value='Negotiate']",
        ],
    ];

    let appcmd = r"C:\Windows\System32\inetsrv\appcmd.exe";
    for args in commands {
        match Command::new(appcmd).args(args).output() {
            Ok(out) if out.status.success() => {}
            Ok(out) => notes.push(format!(
                "appcmd {} exited {}: {}{}",
                args.join(" "),
                out.status,
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            )),
            Err(e) => notes.push(format!("Failed to launch appcmd for '{}': {e}", args.join(" "))),
        }
    }

    notes.join(" | ")
}

/// K2's own web.config files are written as UTF-16LE with a BOM (confirmed
/// via `file` against a real K2Services\web.config: "Unicode text, UTF-16,
/// little-endian" - matching the file's own `encoding="utf-16"` XML
/// declaration), not UTF-8. `std::fs::read_to_string` only accepts UTF-8
/// and silently errors on this content, which is exactly why an earlier
/// version of this fix's `if let Ok(contents) = std::fs::read_to_string(..)`
/// silently did nothing at all - confirmed against a real post-run copy of
/// the file still containing the untouched sectionGroup. Read/write UTF-16LE
/// directly instead, preserving the BOM so IIS/ASP.NET still recognizes the
/// file's encoding correctly.
#[cfg(target_os = "windows")]
fn read_utf16le_file(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 2 || bytes[0] != 0xFF || bytes[1] != 0xFE {
        return None;
    }
    let units: Vec<u16> = bytes[2..]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

#[cfg(target_os = "windows")]
fn write_utf16le_file(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let mut bytes = vec![0xFFu8, 0xFE];
    for unit in content.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    std::fs::write(path, bytes)
}

/// Pulls a VARIABLES value back out of the answer file XML this app itself
/// generated (format: `<add key="[TOKEN]">value</add>`, see
/// k2SilentInstall.ts), so post-install steps like the K2Services fix
/// above can reuse the real site name without needing a matching new
/// parameter threaded through the Tauri command boundary.
#[cfg(target_os = "windows")]
fn extract_answer_file_value(xml: &str, token: &str) -> Option<String> {
    let needle = format!("<add key=\"[{token}]\">");
    let start = xml.find(&needle)? + needle.len();
    let end = xml[start..].find("</add>")? + start;
    Some(xml[start..end].to_string())
}

/// Removes a top-level `<sectionGroup name="{name}" ...>...</sectionGroup>`
/// element from a web.config's `<configSections>`, matched by name
/// attribute and balanced against nested `<sectionGroup`/`</sectionGroup>`
/// tags (this element type genuinely nests, e.g. "scripting" inside
/// "system.web.extensions"). Returns None if no such element is found, so
/// callers can skip writing the file back when there's nothing to fix.
#[cfg(target_os = "windows")]
fn strip_section_group(xml: &str, name: &str) -> Option<String> {
    let needle = format!("<sectionGroup name=\"{name}\"");
    let start = xml.find(&needle)?;

    let mut depth = 0i32;
    let mut cursor = start;
    let end = loop {
        let next_open = xml[cursor..].find("<sectionGroup").map(|i| cursor + i);
        let next_close = xml[cursor..].find("</sectionGroup>").map(|i| cursor + i);
        match (next_open, next_close) {
            (Some(open), Some(close)) if open < close => {
                depth += 1;
                cursor = open + "<sectionGroup".len();
            }
            (_, Some(close)) => {
                depth -= 1;
                let close_end = close + "</sectionGroup>".len();
                if depth == 0 {
                    break close_end;
                }
                cursor = close_end;
            }
            _ => return None,
        }
    };

    let mut result = String::with_capacity(xml.len());
    result.push_str(&xml[..start]);
    result.push_str(&xml[end..]);
    Some(result)
}

/// Real root cause, confirmed on a real machine: K2's own SetupManager
/// resolves the bare command name `dotnet` via ordinary PATH search when it
/// checks the ".NET Core Hosting and Runtime Bundle" component dependency
/// (ProcessWrapper.Execute: "Start executing process: dotnet"). On a
/// machine with an older, 32-bit `dotnet.exe` earlier on PATH than the real
/// 64-bit one (confirmed: `C:\Program Files (x86)\dotnet\` ahead of
/// `C:\Program Files\dotnet\`) - not unheard of on a box with a lot of
/// accumulated dev tooling - that resolves to the x86 copy's own, older set
/// of runtimes, so `dotnet --list-runtimes` silently reports the wrong
/// answer and the dependency check fails even though the real 64-bit
/// runtime satisfies it. Rather than requiring every operator to manually
/// reorder their machine's PATH (fragile, easy to forget, and this app has
/// no way to make a customer do it), fix it at the one point that actually
/// matters: give the SetupManager child process (and anything it spawns,
/// since children inherit their parent's environment) a PATH with the real
/// 64-bit dotnet directory pinned first, regardless of what the wider
/// machine's PATH looks like.
#[cfg(target_os = "windows")]
fn dotnet_first_path() -> String {
    const REAL_DOTNET_DIR: &str = r"C:\Program Files\dotnet";
    let current = std::env::var("PATH").unwrap_or_default();
    if !std::path::Path::new(REAL_DOTNET_DIR).join("dotnet.exe").is_file() {
        // Nothing to pin - leave PATH exactly as this process already has
        // it rather than inventing a directory that doesn't exist.
        return current;
    }
    let mut entries: Vec<String> = current
        .split(';')
        .filter(|entry| !entry.is_empty())
        .filter(|entry| !entry.eq_ignore_ascii_case(REAL_DOTNET_DIR))
        .map(|entry| entry.to_string())
        .collect();
    entries.insert(0, REAL_DOTNET_DIR.to_string());
    entries.join(";")
}

/// Runs SetupManager.exe once against the given answer file and returns its
/// formatted result, exactly as a single attempt. Does NOT touch the install
/// history journal itself - callers control that, since clearing it before
/// every retry (rather than once per run_real_installer call) would force
/// SetupManager to replay the entire install (IIS, AD, SQL schema, ...) on
/// every retry instead of resuming past the already-completed targets via
/// its own journal, turning a 15-second retry into a 10-minute one.
#[cfg(target_os = "windows")]
fn run_real_installer_once(folder: &std::path::Path, xml_path: &std::path::Path) -> Result<String, String> {
    let exe_path = resolve_setup_exe(folder)?;
    let working_dir = exe_path.parent().unwrap_or(folder);

    let mut child = Command::new(&exe_path)
        .current_dir(working_dir)
        .env("PATH", dotnet_first_path())
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
        let detail = if stderr.is_empty() {
            stdout
        } else if stdout.is_empty() {
            stderr
        } else {
            format!("{stdout}\n{stderr}")
        };

        // Real evidence: SetupManager's own "Version Conflict" dialog fires
        // whenever it's run from anywhere OTHER than its own installed
        // location against a machine with real installed state -
        // independent of the database, Windows services, or registry (all
        // confirmed clean in a real run that still hit this). resolve_setup_exe
        // now runs from the installed location whenever it exists, which is
        // exactly what the dialog itself asks for, so this should only ever
        // fire on a genuinely first-ever run (no installed copy yet) where
        // something else has still left real state behind. Detected here so
        // a customer/operator sees a clear next step instead of a raw,
        // blocking GUI dialog they have no way to script past.
        if detail.contains("does not support updating the installed version") || detail.contains("Version Conflict") {
            return Err(format!(
                "K2's SetupManager refused to continue with a \"Version Conflict\" prompt, which blocks silent/unattended installs since it requires a manual Launch/Exit click. \
                 This normally only happens when running from somewhere other than the installed location (C:\\Program Files\\K2\\Setup\\...) - which this app now prefers automatically once that copy exists. \
                 If you're still hitting this, K2 believes real state from a prior install is present on this host; a full reset (drop the database, remove the K2 Windows services, delete C:\\Program Files\\K2) is the reliable way to get a genuinely clean slate. Raw detail: {detail}"
            ));
        }

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

/// Real root cause, confirmed on the actual machine (not the timing race
/// this project chased earlier): the K2 Configuration Service's own log
/// showed `Certificate not found: CN=LOCALHOST (CN=K2 On Premise Root,
/// O=K2) in LocalMachine/My` on every single startup. The cert DID exist
/// there, and its named root CA was present and trusted in LocalMachine\
/// Root - but replicating .NET's own X509Chain.Build against it produced
/// `NotSignatureValid`: this LOCALHOST leaf certificate was not actually
/// signed by the root CA currently in the store. Across many install
/// attempts over several days, SetupManager regenerates a fresh, self-
/// signed "K2 On Premise Root, O=K2" CA (same subject name, new key pair)
/// - orphaning any leaf certs (LOCALHOST, Region Owner, Environment Owner,
/// ...) signed by an older generation of that root, which no longer
/// exists. Since every generation shares the identical subject name, K2's
/// own lookup can't distinguish stale leaves from current ones. Clearing
/// every K2-generated cert before a fresh run forces SetupManager to
/// (re)generate one single, internally consistent chain instead of mixing
/// leaf certs from a previous root generation with the current root.
#[cfg(target_os = "windows")]
fn clear_k2_generated_certificates() {
    let script = r#"
foreach ($storeName in @('My', 'Root', 'CA')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'LocalMachine')
    $store.Open('ReadWrite')
    $toRemove = $store.Certificates | Where-Object {
        $_.Subject -eq 'CN=K2 On Premise Root, O=K2' -or
        $_.Issuer -like '*K2 On Premise Root*' -or
        $_.Subject -eq 'CN=K2 OAuth High Trust' -or
        $_.Issuer -eq 'CN=K2 OAuth High Trust'
    }
    foreach ($cert in $toRemove) {
        $store.Remove($cert)
    }
    $store.Close()
}
"#;
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output();
}

/// Real evidence (5 consecutive trace logs, InstallerTrace260911_2 through
/// _6) ruled out the "warm restart" theory: SetupManager's own StopService
/// -> StartService -> RegisterShard sequence has a hard ~1-2s gap and fails
/// identically on EVERY attempt, not just occasionally - deterministic, not
/// a race. Since StopService kills the process and StartService launches a
/// brand new one each time, our own pre-warming (which only JITs/pages in
/// a process that then gets killed) can't carry forward. A well-known cause
/// of exactly this "SCM says Started but the app isn't actually ready for
/// several more seconds" symptom is Windows Defender real-time protection
/// re-scanning the EXE/DLLs on every fresh process launch, even when the
/// files are already on disk/page-cached. Excluding the K2 install
/// directory removes that per-launch scan overhead. This does not touch
/// EnableNetworkProtection (already confirmed disabled) - it is a distinct
/// real-time file-scanning setting.
#[cfg(target_os = "windows")]
fn exclude_k2_from_defender(folder: &std::path::Path) {
    let script = format!(
        "Add-MpPreference -ExclusionPath 'C:\\Program Files\\K2\\' -ErrorAction SilentlyContinue; \
         Add-MpPreference -ExclusionPath '{}' -ErrorAction SilentlyContinue",
        folder.display()
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output();
}

/// Real evidence (this project's own trace logs): right after the "K2
/// Server" Windows service reports Running, a handful of targets that still
/// run in the same component (e.g. AllowFrameworkNotificationsProcGroupPermissions)
/// immediately try to open a BaseAPI connection to it on port 5555 - and hit
/// this exact SocketException before the engine's listener is actually
/// ready, which is enough to mark the whole "K2 Server" component failed and
/// cascade into most of the K2 Site/Workspace web-app creation targets that
/// depend on it. Distinct from is_stale_security_context (a real, permanent
/// data-ordering bug in the vendor package) - this is a one-off timing race
/// that a single retry, after actually confirming the port is open, reliably
/// clears.
#[cfg(target_os = "windows")]
fn is_transient_service_race(detail: &str) -> bool {
    detail.contains("actively refused it") && detail.contains(":5555")
}

/// Polls the K2 Server BaseAPI port until it accepts a connection (or gives
/// up after 60s), so the retry that follows doesn't just replay the same
/// race a second time.
#[cfg(target_os = "windows")]
fn wait_for_k2_server_port() {
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(
            &"127.0.0.1:5555".parse().unwrap(),
            Duration::from_millis(500),
        )
        .is_ok()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// Real evidence (this project's own trace logs, both before and after the
/// broad 5x retry loop was removed): the "K2 Server" Windows service starts
/// and initializes well before the "System" account is created, so its live
/// security/session state never picks up that account. When
/// DeployPackage.exe later opens a fresh BaseAPI connection as System to
/// deploy Management.kspx, that stale session breaks - either as
/// `AuthenticationException: Primary Credentials Not Authenticated` or (seen
/// in a later run) a raw `SocketException: An existing connection was
/// forcibly closed by the remote host` mid-transfer, same underlying cause.
/// Either way SetupManager treats it as fatal ("Internal error has caused
/// the install to terminate") and stops outright with no attempt of its
/// own to recover - restarting the actual K2 Server engine (not the
/// dependent microservices the vendor package itself restarts) so it
/// picks up the account, then retrying once, reliably clears it.
#[cfg(target_os = "windows")]
fn is_stale_security_context(detail: &str) -> bool {
    detail.contains("Primary Credentials Not Authenticated")
        || (detail.contains("Management.kspx") && detail.contains("forcibly closed"))
        || (detail.contains("Management.kspx") && detail.contains("AuthenticationException"))
}

/// Restarts the actual K2 Server engine and polls its BaseAPI port until it
/// accepts a connection again, for the specific "stale engine, freshly
/// created account" mismatch documented on is_stale_security_context.
/// SetupManager's own install-history journal already marks earlier steps
/// (like creating the System account) complete, so the retry that follows
/// this skips straight back to (re-)deploying Management.kspx rather than
/// replaying the whole install.
#[cfg(target_os = "windows")]
fn restart_k2_server_engine() {
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Restart-Service -Name 'K2 Server' -Force -ErrorAction SilentlyContinue",
        ])
        .output();

    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(
            &"127.0.0.1:5555".parse().unwrap(),
            Duration::from_millis(500),
        )
        .is_ok()
        {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    // Give the engine a further moment to finish its own internal
    // security-manager/session initialization after the port first opens -
    // accepting a TCP connection is not proof the security subsystem behind
    // it has finished loading.
    std::thread::sleep(Duration::from_secs(10));
}

/// Real evidence, confirmed across two separate runs: a package deployment
/// (seen on both "Management_update4.kspx" and other packages) can crash
/// with a raw `NullReferenceException` inside the vendor's own
/// `DeploySessionResultsRecievedState.Execute` after reporting "Deploying 0
/// of N" - i.e. the deployment session got an empty/malformed result set
/// back and the result-parsing code doesn't handle that gracefully. Unlike
/// the two retry classes above (genuine timing races where the database is
/// fine and should be preserved), this looks like a symptom of
/// inconsistent/partially-deployed state built up across retries against
/// the same database - the practical fix is a genuinely fresh database,
/// not just retrying the same deployment again against the same one.
#[cfg(target_os = "windows")]
fn is_stale_deployment_state(detail: &str) -> bool {
    detail.contains("DeploySessionResultsRecievedState") && detail.contains("NullReferenceException")
}

/// Real evidence from a full customer install log: contrary to this file's
/// own earlier assumption (see fix_k2services_scripting_section_and_auth),
/// SetupManager does NOT always treat the six "K2 Workspace - Set
/// K2Services ..." auth targets as non-fatal - on this run it exited 1 and
/// showed its own "Installation stopped. Click Back to fix the issue above
/// and try again." screen, driven entirely by the same duplicate
/// 'system.web.extensions/scripting/scriptResourceHandler' AppCmd error
/// fix_k2services_scripting_section_and_auth already knows how to repair.
/// Previously this meant run_real_installer's `if let Ok(message)` guard
/// never applied that fix, because the whole call came back Err instead -
/// the same known problem now just needs to be detected as a distinct
/// error class so it can be repaired mid-retry instead of only after a
/// successful run.
#[cfg(target_os = "windows")]
fn is_k2services_scripting_section_conflict(detail: &str) -> bool {
    detail.contains("duplicate 'system.web.extensions/scripting/scriptResourceHandler' section")
}

/// Real evidence, confirmed on two separate packages via two different
/// internal call paths: "App Wizard.kspx" failed inside
/// DeploySessionResultsRecievedState.Execute ("Error Sending Buffer... An
/// existing connection was forcibly closed by the remote host") after
/// deploying 256 of 387 items; "Management_update4.kspx" failed inside a
/// completely different path (SendInstructionRequest.OnExecute ->
/// SyncRequest.Complete -> Session.EndInstruction, "Error Receiving
/// Buffer... An existing connection was forcibly closed by the remote
/// host") after uploading 100% of its model and stalling ~2m20s before the
/// drop. Different vendor call stacks, same underlying symptom - a plain
/// socket disconnect mid-deployment - so this matches on the symptom
/// itself (APICommunicationException + forcibly-closed/SocketException)
/// rather than one specific internal state class name, which is real but
/// too narrow (missed the second case entirely). Unlike
/// is_stale_deployment_state's NullReferenceException variant (genuinely
/// corrupted state needing a fresh database), this is a plain transient
/// network hiccup on an otherwise-healthy deployment session - a simple
/// retry against the same database is the correct recovery, the same as
/// is_transient_service_race, not a destructive database reset. Without
/// this, the whole install terminates fatally on one dropped connection
/// instead of the auto-retry catching it.
#[cfg(target_os = "windows")]
fn is_transient_deployment_socket_error(detail: &str) -> bool {
    detail.contains("APICommunicationException")
        && (detail.contains("SocketException") || detail.contains("forcibly closed"))
        && !detail.contains("NullReferenceException")
}

/// Drops and recreates the K2 database via the same DotNetRunner path
/// test_sql_connection/drop_k2_database use, so the retry after this gets
/// a genuinely clean database instead of resuming onto whatever
/// partially-deployed state caused is_stale_deployment_state. Errors are
/// intentionally swallowed (best-effort) - if this fails, the following
/// retry will just fail again with a clearer, real error instead of this
/// recovery attempt masking it.
#[cfg(target_os = "windows")]
fn reset_k2_database(instance: &str, auth_mode: &str, username: &str, password: &str, database: &str) {
    let runner = crate::commands::dotnet_runner_path();
    let _ = Command::new(&runner)
        .args(["drop-database", instance, auth_mode, username, password, database])
        .output();
    let _ = Command::new(&runner)
        .args(["test-sql", instance, auth_mode, username, password, database])
        .output();
}

#[tauri::command]
pub async fn run_real_installer(
    installation_folder: String,
    silent_xml_contents: String,
    sql_instance: String,
    sql_auth_mode: String,
    sql_username: String,
    sql_password: String,
    sql_database: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let folder = PathBuf::from(&installation_folder);
            let xml_path = std::env::temp_dir().join("k2-silent-install.xml");
            std::fs::write(&xml_path, &silent_xml_contents)
                .map_err(|e| format!("Failed to write answer file {}: {e}", xml_path.display()))?;

            clear_install_history_journal();
            exclude_k2_from_defender(&folder);
            clear_k2_generated_certificates();
            remove_stale_bracketed_workspace_site();
            let site_name = extract_answer_file_value(&silent_xml_contents, "SITENAME").unwrap_or_else(|| "K2".to_string());

            let mut result = match run_real_installer_once(&folder, &xml_path) {
                Ok(message) => Ok(message),
                Err(err) if is_transient_service_race(&err) => {
                    wait_for_k2_server_port();
                    run_real_installer_once(&folder, &xml_path)
                }
                Err(err) if is_transient_deployment_socket_error(&err) => {
                    // Real evidence: this flaky socket drop can recur on a
                    // second attempt in a row (confirmed - a retry hit the
                    // exact same "forcibly closed by the remote host" error
                    // again before finally succeeding on a third, manual
                    // re-run), so one retry alone isn't always enough. Keep
                    // retrying while this exact error class keeps recurring,
                    // up to a small bounded number of extra attempts, rather
                    // than giving up and terminating the whole install on
                    // what's ultimately just network flakiness.
                    let mut attempt_result = run_real_installer_once(&folder, &xml_path);
                    for _ in 0..2 {
                        match &attempt_result {
                            Err(retry_err) if is_transient_deployment_socket_error(retry_err) => {
                                attempt_result = run_real_installer_once(&folder, &xml_path);
                            }
                            _ => break,
                        }
                    }
                    attempt_result
                }
                Err(err) if is_stale_security_context(&err) => {
                    restart_k2_server_engine();
                    run_real_installer_once(&folder, &xml_path)
                }
                Err(err) if is_stale_deployment_state(&err) => {
                    reset_k2_database(&sql_instance, &sql_auth_mode, &sql_username, &sql_password, &sql_database);
                    // A fresh database has none of the earlier targets'
                    // completions recorded against it - force a full
                    // replay from scratch rather than resuming a journal
                    // that thinks most of the install already happened.
                    clear_install_history_journal();
                    run_real_installer_once(&folder, &xml_path)
                }
                Err(err) if is_k2services_scripting_section_conflict(&err) => {
                    // These six targets never got marked complete in the
                    // journal, so the retry will re-attempt them (unlike
                    // the earlier, already-succeeded targets it skips).
                    // Strip the duplicate sectionGroup ourselves first so
                    // this time the retry's own AppCmd calls against
                    // K2Services\web.config succeed instead of hitting the
                    // exact same "duplicate section defined" error again.
                    let _ = fix_k2services_scripting_section_and_auth(&site_name);
                    run_real_installer_once(&folder, &xml_path)
                }
                Err(err) => Err(err),
            };

            if let Ok(message) = &mut result {
                let notes = fix_k2services_scripting_section_and_auth(&site_name);
                message.push_str(&format!("\n{notes}"));

                // The pre-run removal only catches a phantom "[K2SITENAME]"
                // site left over from a PRIOR run - if this run's own
                // "K2 Workspace - Create K2 Workspace Site" target hit the
                // same unresolved-token bug again, the phantom site (and
                // its port binding) would only exist from partway through
                // this run onward, so check again now that it's over.
                remove_stale_bracketed_workspace_site();

                // Re-grant now too, not just in configure_iis_site: the
                // real K2 files land in this folder well after that early
                // grant ran, and a package extraction can lay down its own,
                // more restrictive ACLs on top of what's already there.
                let acl_notes = grant_iis_read_access_to_k2_webservices();
                message.push_str(&format!("\n{acl_notes}"));

                let start_notes = start_real_k2_site(&site_name);
                message.push_str(&format!("\n{start_notes}"));
            }

            result
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (
                installation_folder,
                silent_xml_contents,
                sql_instance,
                sql_auth_mode,
                sql_username,
                sql_password,
                sql_database,
            );
            unsupported("Running the real K2 installer")
        }
    })
    .await
    .map_err(|e| format!("Background task failed: {e}"))?
}

/// While SetupManager is mid-run, its trace log lives at
/// `%TEMP%\K2 Setup Log\InstallerTrace<date>_<n>.log` (it only gets moved
/// to `INSTALLDIR\Setup\Log` at exit - see Execution.SaveInstallState in
/// every trace log's own tail). Without this, the UI has nothing to show
/// during a run that can genuinely take 10-20+ minutes except a static
/// "Running SourceCode.SetupManager.exe /install" the whole time, which
/// reads as hung/broken even when progressing normally. Polled from the
/// frontend while the "components" task is active to surface the
/// installer's own real current step instead.
#[cfg(target_os = "windows")]
fn is_noise_log_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with("==") || trimmed.starts_with("Program.InstantiateLog")
}

#[tauri::command]
pub fn get_latest_installer_log_line() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let log_dir = std::env::temp_dir().join("K2 Setup Log");
        let newest = std::fs::read_dir(&log_dir)
            .ok()?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("InstallerTrace")
            })
            .max_by_key(|entry| entry.metadata().and_then(|m| m.modified()).ok())?;

        let contents = std::fs::read_to_string(newest.path()).ok()?;
        contents
            .lines()
            .rev()
            .map(|line| line.trim_start_matches(['>', ' ']).trim())
            .find(|line| !is_noise_log_line(line))
            .map(|line| line.to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
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
