param(
    [string]$Subject = "*Region Owner*",
    [string]$HostName = "localhost",
    [int]$Port = 5560
)

Add-Type -AssemblyName System.Net.Security -ErrorAction SilentlyContinue

$cert = Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -like $Subject | Select-Object -First 1
if (-not $cert) {
    Write-Host "No certificate found matching $Subject" -ForegroundColor Red
    exit 1
}
Write-Host "Using certificate: $($cert.Subject) ($($cert.Thumbprint))"

$certs = New-Object System.Security.Cryptography.X509Certificates.X509CertificateCollection
$certs.Add($cert) | Out-Null

$tcp = New-Object System.Net.Sockets.TcpClient
try {
    Write-Host "Connecting to $HostName`:$Port ..."
    $tcp.Connect($HostName, $Port)
    Write-Host "TCP connected."

    $validateCallback = { param($sender, $certificate, $chain, $errors) return $true }

    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $validateCallback)

    Write-Host "Starting TLS handshake (AuthenticateAsClient)..."
    try {
        $ssl.AuthenticateAsClient($HostName, $certs, [System.Security.Authentication.SslProtocols]::Tls12, $false)
        Write-Host "Handshake SUCCEEDED." -ForegroundColor Green
        Write-Host "Protocol: $($ssl.SslProtocol)  Cipher: $($ssl.CipherAlgorithm) $($ssl.CipherStrength)-bit"
        Write-Host "Is mutually authenticated: $($ssl.IsMutuallyAuthenticated)"
        Write-Host "Local cert used: $($ssl.LocalCertificate.Subject)"

        Write-Host "`nHandshake succeeded - now testing a data read (this is where the real failure happens per the K2 trace)..."
        $requestBytes = [System.Text.Encoding]::ASCII.GetBytes("GET / HTTP/1.1`r`nHost: $HostName`:$Port`r`nConnection: close`r`n`r`n")
        $ssl.Write($requestBytes, 0, $requestBytes.Length)
        $ssl.Flush()

        $buffer = New-Object byte[] 4096
        try {
            $read = $ssl.Read($buffer, 0, $buffer.Length)
            Write-Host "Read $read bytes successfully:" -ForegroundColor Green
            Write-Host ([System.Text.Encoding]::ASCII.GetString($buffer, 0, $read))
        } catch {
            Write-Host "READ FAILED (this matches the K2 EndRead failure):" -ForegroundColor Red
            Write-Host $_.Exception.ToString()
        }
    } catch {
        Write-Host "HANDSHAKE FAILED:" -ForegroundColor Red
        Write-Host $_.Exception.ToString()
    }
} catch {
    Write-Host "CONNECTION FAILED:" -ForegroundColor Red
    Write-Host $_.Exception.ToString()
} finally {
    $tcp.Close()
}
