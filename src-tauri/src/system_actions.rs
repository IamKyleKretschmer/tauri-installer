use std::process::Command;

/// Writes the install log to the current user's Desktop and returns the
/// full path. Content is passed over stdin rather than embedded in the
/// PowerShell script string, so arbitrary log text (quotes, newlines)
/// can't break out of the script.
#[tauri::command]
pub fn write_install_log(contents: String) -> Result<String, String> {
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
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .map_err(|e| format!("Failed to launch PowerShell: {e}"))?;

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
pub fn configure_iis_site(
    site_name: String,
    http_port: String,
    https_port: String,
    app_pool_identity: String,
    certificate_thumbprint: String,
) -> Result<String, String> {
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

$sitePhysicalPath = "$env:ProgramFiles\K2\WebServices"
New-Item -ItemType Directory -Force -Path $sitePhysicalPath | Out-Null
New-Website -Name $site -Port $httpPort -PhysicalPath $sitePhysicalPath -ApplicationPool $site -Force | Out-Null

foreach ($app in $webApps) {{
    $appPoolName = "$site $app"
    if (-not (Test-Path "IIS:\AppPools\$appPoolName")) {{
        New-WebAppPool -Name $appPoolName | Out-Null
        Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name processModel.identityType -Value $identity
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
pub fn copy_k2_files(source_root: String) -> Result<String, String> {
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
}

/// Drops a minimal placeholder page into any K2 web app folder that came
/// out of copy_k2_files still empty (no real K2 payload was available),
/// so that browsing to that app's IIS URL after install resolves to a
/// real, identifiable page instead of a blank folder listing or 404.
/// Never overwrites a folder that already has real content in it.
#[tauri::command]
pub fn scaffold_k2_placeholder_pages() -> Result<String, String> {
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
}

/// Removes the K2 site, its own app pool, and every K2 web application
/// app pool created by configure_iis_site. Leaves the physical files on
/// disk untouched (only the IIS configuration is reverted); scoped to
/// just this one site name and its own app pools, same as
/// configure_iis_site is scoped when creating them.
#[tauri::command]
pub fn remove_iis_site(site_name: String) -> Result<String, String> {
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
}

/// Disables TLS 1.0 and 1.1 for both Client and Server roles via the
/// Schannel registry keys. Machine-wide: affects every app/service on
/// this box, not just K2, and typically needs a reboot to fully take
/// effect for other already-running services.
#[tauri::command]
pub fn disable_legacy_tls() -> Result<String, String> {
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
}

/// Reverses disable_legacy_tls: re-enables TLS 1.0 and 1.1 for both
/// Client and Server roles via the same Schannel registry keys.
/// Machine-wide, same caveat as the original action.
#[tauri::command]
pub fn restore_legacy_tls() -> Result<String, String> {
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
}

/// Grants the given account the "Log on as a service" local security
/// policy right (SeServiceLogonRight), via the standard secedit
/// export/edit/import approach (there is no direct PowerShell cmdlet for
/// user rights assignment). Scoped to just this one right for this one
/// account; removing the account from that policy undoes it.
#[tauri::command]
pub fn grant_service_logon_right(account: String) -> Result<String, String> {
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
}

/// Reverses grant_service_logon_right: removes the given account's SID
/// from the SeServiceLogonRight local security policy line, via the
/// same secedit export/edit/import round-trip. Leaves the right intact
/// for any other accounts already granted it.
#[tauri::command]
pub fn revoke_service_logon_right(account: String) -> Result<String, String> {
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
}
