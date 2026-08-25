use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
pub struct CheckResult {
    pub pass: bool,
    pub detail: String,
}

const MIN_BUILD_NUMBER: u32 = 14393; // Windows Server 2016 / Windows 10 1607
const MIN_CPU_MHZ: u32 = 2000;
const MIN_RAM_GB: f64 = 8.0;
const MIN_DISK_GB: f64 = 10.0;
const MIN_DISPLAY_WIDTH: u32 = 1024;
const MIN_DISPLAY_HEIGHT: u32 = 768;

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Option<String> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(not(target_os = "windows"))]
fn unsupported(check: &str) -> CheckResult {
    CheckResult {
        pass: false,
        detail: format!("{check} check requires Windows"),
    }
}

#[tauri::command]
pub fn check_os() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$os = Get-CimInstance Win32_OperatingSystem; "$($os.Caption)|$($os.OSArchitecture)|$([System.Environment]::OSVersion.Version.Build)""#;
        if let Some(out) = run_powershell(script) {
            let parts: Vec<&str> = out.split('|').map(str::trim).collect();
            if let [caption, arch, build] = parts.as_slice() {
                let build_number: u32 = build.parse().unwrap_or(0);
                let pass = build_number >= MIN_BUILD_NUMBER && arch.contains("64");
                return CheckResult {
                    pass,
                    detail: format!("{caption} ({arch})"),
                };
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine OS version".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Operating system")
    }
}

#[tauri::command]
pub fn check_cpu() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = "(Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed";
        if let Some(out) = run_powershell(script) {
            if let Ok(mhz) = out.trim().parse::<u32>() {
                return CheckResult {
                    pass: mhz >= MIN_CPU_MHZ,
                    detail: format!("{:.1} GHz", mhz as f64 / 1000.0),
                };
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine processor speed".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Processor speed")
    }
}

#[tauri::command]
pub fn check_ram() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        // TotalVisibleMemorySize is reported in kilobytes.
        let script = "(Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize";
        if let Some(out) = run_powershell(script) {
            if let Ok(kb) = out.trim().parse::<f64>() {
                let gb = kb / 1024.0 / 1024.0;
                return CheckResult {
                    pass: gb >= MIN_RAM_GB,
                    detail: format!("{gb:.1} GB installed"),
                };
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine installed RAM".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Available RAM")
    }
}

#[tauri::command]
pub fn check_disk() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$drive = $env:SystemDrive; $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"; "$drive|$($disk.FreeSpace)""#;
        if let Some(out) = run_powershell(script) {
            let parts: Vec<&str> = out.split('|').map(str::trim).collect();
            if let [drive, free_bytes] = parts.as_slice() {
                if let Ok(bytes) = free_bytes.parse::<f64>() {
                    let gb = bytes / 1_073_741_824.0;
                    return CheckResult {
                        pass: gb >= MIN_DISK_GB,
                        detail: format!("{gb:.1} GB free on {drive}"),
                    };
                }
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine free disk space".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Disk space")
    }
}

#[tauri::command]
pub fn check_display() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"Add-Type -AssemblyName System.Windows.Forms; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "$($b.Width)x$($b.Height)""#;
        if let Some(out) = run_powershell(script) {
            let parts: Vec<&str> = out.split('x').map(str::trim).collect();
            if let [width, height] = parts.as_slice() {
                if let (Ok(w), Ok(h)) = (width.parse::<u32>(), height.parse::<u32>()) {
                    return CheckResult {
                        pass: w >= MIN_DISPLAY_WIDTH && h >= MIN_DISPLAY_HEIGHT,
                        detail: format!("{w}x{h}"),
                    };
                }
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine display resolution".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Display resolution")
    }
}

/// Informational only: an absent SQL Server does not fail System check
/// because the Prerequisites step offers to install SQL Server Express.
#[tauri::command]
pub fn check_sql_server() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL') { ((Get-Item 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL').Property) -join ',' } else { '' }"#;
        match run_powershell(script) {
            Some(instances) if !instances.trim().is_empty() => CheckResult {
                pass: true,
                detail: format!("Instance(s) detected: {}", instances.trim()),
            },
            _ => CheckResult {
                pass: false,
                detail: "Not detected, SQL Server Express will be installed".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("SQL Server")
    }
}

/// Informational only: an absent IIS does not fail System check because
/// the Prerequisites step offers to enable it via Windows Features.
#[tauri::command]
pub fn check_iis() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script =
            "(Get-WindowsOptionalFeature -Online -FeatureName IIS-WebServerRole -ErrorAction SilentlyContinue).State";
        match run_powershell(script) {
            Some(state) if state.trim() == "Enabled" => CheckResult {
                pass: true,
                detail: "IIS is installed and enabled".to_string(),
            },
            _ => CheckResult {
                pass: false,
                detail: "Not detected, will be enabled via Windows Features".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("IIS")
    }
}

/// Checks the official Microsoft-documented registry location for the
/// VC++ 2015-2022 x64 redistributable (the "Runtimes" key, present under
/// both the native and WOW6432Node hives depending on OS architecture).
#[tauri::command]
pub fn check_vc_redist() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$keys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\X64',
    'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64'
)
foreach ($key in $keys) {
    if (Test-Path $key) {
        $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
        if ($item.Installed -eq 1) {
            "$($item.Version)"
            break
        }
    }
}
"#;
        match run_powershell(script) {
            Some(version) => CheckResult {
                pass: true,
                detail: format!("VC++ Redistributable {} installed", version.trim()),
            },
            None => CheckResult {
                pass: false,
                detail: "Not found. Required by SQL Server components.".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("VC++ Redistributable")
    }
}

/// TLS 1.2 is on by default on Windows Server 2016+/Windows 10+ unless a
/// SCHANNEL registry override explicitly disables it, so an absent key
/// means enabled, not unknown.
#[tauri::command]
pub fn check_tls12() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server'
if (-not (Test-Path $key)) { "default-enabled" }
else {
    $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    $enabled = ($item.Enabled -ne 0) -and ($item.DisabledByDefault -ne 1)
    if ($enabled) { "enabled" } else { "disabled" }
}
"#;
        match run_powershell(script).as_deref() {
            Some("default-enabled") => CheckResult {
                pass: true,
                detail: "Enabled by default (no registry override present)".to_string(),
            },
            Some("enabled") => CheckResult {
                pass: true,
                detail: "Detected as enabled in Schannel registry".to_string(),
            },
            _ => CheckResult {
                pass: false,
                detail: "Currently disabled. K2 requires TLS 1.2.".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("TLS 1.2")
    }
}

/// Passes when TLS 1.0 and 1.1 are already disabled (nothing for
/// Prerequisites/Install to do); fails (needs action) if either is still
/// enabled or left at its OS default, which is enabled on older builds.
#[tauri::command]
pub fn check_tls_legacy() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
function Test-Disabled($version) {
    $key = "HKLM:\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\$version\Server"
    if (-not (Test-Path $key)) { return $false }
    $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    return ($item.Enabled -eq 0) -or ($item.DisabledByDefault -eq 1)
}
$tls10 = Test-Disabled 'TLS 1.0'
$tls11 = Test-Disabled 'TLS 1.1'
"$tls10|$tls11"
"#;
        if let Some(out) = run_powershell(script) {
            let parts: Vec<&str> = out.split('|').map(str::trim).collect();
            if let [tls10, tls11] = parts.as_slice() {
                let both_disabled = tls10.eq_ignore_ascii_case("true") && tls11.eq_ignore_ascii_case("true");
                return CheckResult {
                    pass: both_disabled,
                    detail: if both_disabled {
                        "TLS 1.0 and 1.1 are already disabled".to_string()
                    } else {
                        "Currently enabled. K2 requires these to be disabled.".to_string()
                    },
                };
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine TLS 1.0/1.1 state".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("TLS 1.0/1.1")
    }
}

/// Passing means IPv4 is active on some adapter, which is what K2
/// requires; the Network & TLS screen's "IPv6-only mode" row is the
/// inverse of this same fact, so it isn't queried separately.
#[tauri::command]
pub fn check_ipv4() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"
$addr = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -First 1 -ExpandProperty IPAddress
if ($addr) { $addr }
"#;
        match run_powershell(script) {
            Some(addr) => CheckResult {
                pass: true,
                detail: format!("IPv4 active on primary adapter ({addr})"),
            },
            None => CheckResult {
                pass: false,
                detail: "No active IPv4 address found. K2 requires IPv4.".to_string(),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("IPv4")
    }
}

/// Reports whether a TCP port is free to bind, for IIS site HTTP/HTTPS
/// port validation on the IIS & .NET screen.
#[tauri::command]
pub fn check_port(port: u16) -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            "if (Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue) {{ 'in-use' }} else {{ 'free' }}"
        );
        match run_powershell(&script).as_deref() {
            Some("in-use") => CheckResult {
                pass: false,
                detail: format!("Port {port} is already in use by another process"),
            },
            _ => CheckResult {
                pass: true,
                detail: format!("Port {port} is available"),
            },
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = port;
        unsupported("Port availability")
    }
}

#[derive(Serialize)]
pub struct CertificateInfo {
    pub thumbprint: String,
    pub subject: String,
}

/// Lists certificates from the LocalMachine\My store, for the SSL
/// certificate picker on the IIS & .NET screen.
#[tauri::command]
pub fn list_certificates() -> Vec<CertificateInfo> {
    #[cfg(target_os = "windows")]
    {
        let script = r#"Get-ChildItem Cert:\LocalMachine\My | ForEach-Object { "$($_.Thumbprint)|$($_.Subject)" }"#;
        match run_powershell(script) {
            Some(out) => out
                .lines()
                .filter_map(|line| {
                    let mut parts = line.splitn(2, '|');
                    let thumbprint = parts.next()?.trim().to_string();
                    let subject = parts.next()?.trim().to_string();
                    Some(CertificateInfo { thumbprint, subject })
                })
                .collect(),
            None => Vec::new(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// Returns this machine's FQDN, used to prefill the K2 server hostname
/// field on the Network & TLS screen.
#[tauri::command]
pub fn get_machine_fqdn() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        run_powershell("[System.Net.Dns]::GetHostEntry([System.Net.Dns]::GetHostName()).HostName")
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Checks whether this machine is joined to an Active Directory domain.
#[tauri::command]
pub fn check_domain_joined() -> CheckResult {
    #[cfg(target_os = "windows")]
    {
        let script = r#"$cs = Get-CimInstance Win32_ComputerSystem; "$($cs.PartOfDomain)|$($cs.Domain)""#;
        if let Some(out) = run_powershell(script) {
            let parts: Vec<&str> = out.split('|').map(str::trim).collect();
            if let [part_of_domain, domain] = parts.as_slice() {
                let pass = part_of_domain.eq_ignore_ascii_case("true");
                return CheckResult {
                    pass,
                    detail: if pass {
                        format!("Domain detected: {domain}. This machine is domain-joined.")
                    } else {
                        "This machine is not joined to an Active Directory domain.".to_string()
                    },
                };
            }
        }
        CheckResult {
            pass: false,
            detail: "Could not determine domain membership".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        unsupported("Active Directory")
    }
}
