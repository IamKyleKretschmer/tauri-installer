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

$sitePhysicalPath = "$env:SystemDrive\Program Files (x86)\K2\Web Bin"
New-Item -ItemType Directory -Force -Path $sitePhysicalPath | Out-Null
New-Website -Name $site -Port $httpPort -PhysicalPath $sitePhysicalPath -ApplicationPool $site -Force | Out-Null

foreach ($app in $webApps) {{
    $appPoolName = "$site $app"
    if (-not (Test-Path "IIS:\AppPools\$appPoolName")) {{
        New-WebAppPool -Name $appPoolName | Out-Null
        Set-ItemProperty "IIS:\AppPools\$appPoolName" -Name processModel.identityType -Value $identity
    }}
    $appPhysicalPath = Join-Path $sitePhysicalPath "Webservices\$app"
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

/// Mirrors the legacy SourceCode.Install.Common "copy file" install
/// action (e.g. sourcecode.dll -> hostserver/bin): copies the contents
/// of a source folder (real K2 server/web files supplied by the caller)
/// into the K2 Host Server bin folder. If no source path is given, this
/// is skipped entirely rather than failing, since a bare spike install
/// may not have the real product payload available yet.
#[tauri::command]
pub fn copy_k2_files(source_path: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if source_path.trim().is_empty() {
            return Ok("No K2 source files folder was provided, skipping file deployment".to_string());
        }

        let script = format!(
            r#"
$source = '{source_path}'
if (-not (Test-Path -LiteralPath $source)) {{ throw "Source files folder not found: $source" }}
$dest = "$env:SystemDrive\Program Files (x86)\K2\Host Server\Bin"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
robocopy $source $dest /E /NFL /NDL /NJH /NJS /NC /NS | Out-Null
$copied = (Get-ChildItem -LiteralPath $dest -Recurse -File | Measure-Object).Count
"Copied $copied file(s) from $source to $dest"
"#
        );
        run_powershell(&script)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = source_path;
        unsupported("Copying K2 files")
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
