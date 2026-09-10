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
    Write-Host "FAILURES:"
    $failures | ForEach-Object { Write-Host "  $_" }
}
if ($removed.Count -eq 0) {
    "No K2 product registrations found, nothing to remove"
} else {
    "Removed $($removed.Count): $($removed -join ', ')"
}
