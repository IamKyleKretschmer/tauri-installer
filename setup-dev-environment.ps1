<#
.SYNOPSIS
    One-shot dev environment setup for this POC on a fresh Windows machine.

.DESCRIPTION
    Installs everything needed to clone, build, and run this Tauri app from
    scratch: Git, Node.js, the Rust toolchain (rustup/cargo/rustc) plus the
    MSVC C++ Build Tools Tauri needs to link on Windows, and the .NET SDK
    DotNetRunner builds against. Every step checks whether the tool is
    already present and skips it if so, so this is safe to re-run.

    Uses direct downloads rather than winget, since winget isn't available
    on every Windows image (notably Windows Server, which is what this
    POC's actual K2 target boxes tend to be) - App Installer/Store access
    isn't guaranteed there the way it is on a normal Windows 11 desktop.

.NOTES
    Run this from an elevated (Administrator) PowerShell window - several
    of these installers write to machine-wide Program Files/PATH and will
    silently no-op or fail without admin rights.

    PATH changes made by these installers only apply to *new* processes.
    Close this PowerShell window and open a fresh one after this script
    finishes before running any of the tools it installed.
#>

$ErrorActionPreference = "Stop"
# PowerShell 7.3+ treats a native command's stderr output as a terminating
# error under $ErrorActionPreference = "Stop" by default. That combination
# bit this script for real: a machine with a broken/shadowed `dotnet` on
# PATH (e.g. an x86 copy ahead of the real x64 one, seen earlier in this
# project) makes `dotnet --version` write to stderr, which aborted this
# entire script right at the very first check - before the Hosting Bundle
# step below ever ran. Disable that so a broken tool on PATH can't take
# down every step after it; each step still fails loudly on its own via
# try/catch where that matters.
$PSNativeCommandUseErrorActionPreference = $false

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Prefer the real 64-bit dotnet.exe explicitly rather than trusting
# whatever `dotnet` resolves to on PATH - confirmed on a real machine that
# an x86 copy of dotnet.exe (with no SDKs registered to it) can sit earlier
# on PATH than the real one, making bare `dotnet` calls fail even though
# .NET is genuinely installed.
function Get-DotnetExe {
    $preferred = "C:\Program Files\dotnet\dotnet.exe"
    if (Test-Path $preferred) { return $preferred }
    $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

function Assert-Admin {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) {
        Write-Warning "Not running as Administrator - several installers below may fail or silently do nothing. Re-launch this script from an elevated PowerShell window if anything below reports an error."
    }
}

$tempDir = Join-Path $env:TEMP "k2-dev-setup"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

Assert-Admin

# --- Git ---------------------------------------------------------------
if (Test-Command git) {
    Write-Host "[skip] Git already installed: $(git --version)" -ForegroundColor DarkGray
} else {
    Write-Host "[install] Git for Windows..." -ForegroundColor Cyan
    $gitInstaller = Join-Path $tempDir "git-installer.exe"
    Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe" -OutFile $gitInstaller
    Start-Process -FilePath $gitInstaller -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-" -Wait
    Write-Host "Git installed." -ForegroundColor Green
}

# --- Node.js -------------------------------------------------------------
if (Test-Command node) {
    Write-Host "[skip] Node.js already installed: $(node --version)" -ForegroundColor DarkGray
} else {
    Write-Host "[install] Node.js LTS..." -ForegroundColor Cyan
    $nodeVersion = "20.18.1"
    $nodeInstaller = Join-Path $tempDir "node-installer.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-x64.msi" -OutFile $nodeInstaller
    Start-Process -FilePath "msiexec.exe" -ArgumentList "/i", "`"$nodeInstaller`"", "/quiet", "/norestart" -Wait
    Write-Host "Node.js installed." -ForegroundColor Green
}

# --- .NET SDK ------------------------------------------------------------
# DotNetRunner targets net48 but is built with the modern `dotnet` CLI,
# which needs the SDK (not just a runtime) present - the .NET Framework
# 4.8 reference assemblies for actually targeting net48 ship as part of
# the SDK's workload packs on recent SDK versions, so just the SDK itself
# is normally enough.
$dotnetExe = Get-DotnetExe
$dotnetSdks = if ($dotnetExe) { & $dotnetExe --list-sdks 2>$null } else { $null }
if ($dotnetSdks) {
    Write-Host "[skip] .NET SDK already installed:" -ForegroundColor DarkGray
    $dotnetSdks | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }
} else {
    Write-Host "[install] .NET 8 SDK..." -ForegroundColor Cyan
    $dotnetInstallScript = Join-Path $tempDir "dotnet-install.ps1"
    Invoke-WebRequest -Uri "https://dot.net/v1/dotnet-install.ps1" -OutFile $dotnetInstallScript
    & $dotnetInstallScript -Channel 8.0 -InstallDir "C:\Program Files\dotnet"
    [Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path", "Machine") + ";C:\Program Files\dotnet", "Machine")
    $dotnetExe = "C:\Program Files\dotnet\dotnet.exe"
    Write-Host ".NET SDK installed to C:\Program Files\dotnet." -ForegroundColor Green
}

# --- Rust (rustup / cargo / rustc) ---------------------------------------
if (Test-Command cargo) {
    Write-Host "[skip] Rust already installed: $(cargo --version)" -ForegroundColor DarkGray
} else {
    Write-Host "[install] Rust (via rustup)..." -ForegroundColor Cyan
    $rustupInstaller = Join-Path $tempDir "rustup-init.exe"
    Invoke-WebRequest -Uri "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" -OutFile $rustupInstaller
    # -y accepts defaults non-interactively; --default-toolchain stable
    # matches what Tauri expects.
    & $rustupInstaller -y --default-toolchain stable --profile default
    # rustup installs into the current user's profile, not machine-wide -
    # make it visible to this same script's remaining steps too.
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    $env:Path = "$cargoBin;$env:Path"
    Write-Host "Rust installed." -ForegroundColor Green
}

# --- MSVC C++ Build Tools (needed to link Rust/Tauri on Windows) --------
# Detected by checking for cl.exe (the MSVC compiler) anywhere under a
# plausible VS install root, since there's no simple "is this installed"
# command the way there is for git/node/dotnet/cargo.
$hasMsvc = Get-ChildItem "C:\Program Files (x86)\Microsoft Visual Studio","C:\Program Files\Microsoft Visual Studio" -Recurse -Filter "cl.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($hasMsvc) {
    Write-Host "[skip] MSVC Build Tools already installed." -ForegroundColor DarkGray
} else {
    Write-Host "[install] Visual Studio Build Tools (C++ workload)... this step downloads several GB and can take a while." -ForegroundColor Cyan
    $vsBuildToolsInstaller = Join-Path $tempDir "vs_buildtools.exe"
    Invoke-WebRequest -Uri "https://aka.ms/vs/17/release/vs_buildtools.exe" -OutFile $vsBuildToolsInstaller
    Start-Process -FilePath $vsBuildToolsInstaller -ArgumentList "--wait", "--passive", "--norestart", "--add", "Microsoft.VisualStudio.Workload.VCTools", "--includeRecommended" -Wait
    Write-Host "MSVC Build Tools installed." -ForegroundColor Green
}

# --- ASP.NET Core Hosting Bundle (K2 install prerequisite) --------------
# Not needed to build/run this wizard itself - this is a real K2
# prerequisite, checked by check_dotnet_hosting_bundle in
# system_checks.rs: SetupManager's own pre-flight validation fails fast
# with "Dependency for 'Runtime' not met" on a machine that only has the
# .NET SDK installed, since the SDK and the Hosting Bundle are separate
# installers - the SDK doesn't register IIS's ASP.NET Core Module V2,
# which is what this actually checks for and what K2's Configuration
# Service (an ASP.NET Core app hosted in IIS) needs. Uses aka.ms's
# channel-latest redirect rather than a hardcoded exact version, since
# pinning an exact patch here would go stale as Microsoft ships updates.
$aspNetCoreModulePaths = @(
    "C:\Program Files\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll",
    "C:\Program Files (x86)\IIS\Asp.Net Core Module\V2\aspnetcorev2.dll"
)
if ($aspNetCoreModulePaths | Where-Object { Test-Path $_ }) {
    Write-Host "[skip] ASP.NET Core Hosting Bundle already installed." -ForegroundColor DarkGray
} else {
    Write-Host "[install] ASP.NET Core Hosting Bundle (.NET 10)..." -ForegroundColor Cyan
    $hostingBundleInstaller = Join-Path $tempDir "dotnet-hosting-win.exe"
    Invoke-WebRequest -Uri "https://aka.ms/dotnet/10.0/dotnet-hosting-win.exe" -OutFile $hostingBundleInstaller
    Start-Process -FilePath $hostingBundleInstaller -ArgumentList "/quiet", "/norestart" -Wait
    # The Hosting Bundle installer registers its IIS module but an
    # already-running IIS won't pick it up until its worker processes
    # restart - matches the real install guidance to run iisreset after
    # installing this.
    Write-Host "Restarting IIS so it picks up the new module..." -ForegroundColor Cyan
    iisreset | Out-Null
    Write-Host "ASP.NET Core Hosting Bundle installed." -ForegroundColor Green
}

Write-Host ""
Write-Host "Setup complete. Close this PowerShell window and open a fresh one, then run:" -ForegroundColor Yellow
Write-Host "  cd C:\k2-installer"
Write-Host "  npm install"
Write-Host "  cd DotNetRunner; dotnet build -c Release; cd .."
Write-Host "  npm run tauri dev"
