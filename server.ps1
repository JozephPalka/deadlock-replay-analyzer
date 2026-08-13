<#
    server.ps1 — a tiny static file server for the Deadlock Replay Analyzer.

    Why this exists: the app has to be served over http:// rather than opened as
    a file, because browsers refuse to load ES modules and refuse to give a page
    folder access when it is opened from disk. This uses raw TcpListener rather
    than HttpListener so it never needs administrator rights.

    It serves only the files sitting next to this script, only on 127.0.0.1.
    Nothing is exposed to your network.
#>

param(
    [int]$Port = 8777,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) { $root = (Get-Location).Path }
$root = [System.IO.Path]::GetFullPath($root)

$contentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.md'   = 'text/markdown; charset=utf-8'
    '.map'  = 'application/json'
}

function Get-ContentType([string]$path) {
    $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
    if ($contentTypes.ContainsKey($ext)) { return $contentTypes[$ext] }
    return 'application/octet-stream'
}

# Find a free port, starting from the requested one.
$listener = $null
for ($candidate = $Port; $candidate -lt ($Port + 25); $candidate++) {
    try {
        $attempt = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), $candidate
        $attempt.Start()
        $listener = $attempt
        $Port = $candidate
        break
    } catch {
        $listener = $null
    }
}

if ($null -eq $listener) {
    Write-Host "Could not open a local port between $Port and $($Port + 25)." -ForegroundColor Red
    Write-Host "Something else may be using them. Close it and try again."
    exit 1
}

$url = "http://127.0.0.1:$Port/"

Write-Host ""
Write-Host "  Deadlock Replay Analyzer" -ForegroundColor Cyan
Write-Host "  serving $root"
Write-Host "  open   $url" -ForegroundColor Green
Write-Host ""
Write-Host "  Leave this window open while you use the app. Press Ctrl+C to stop."
Write-Host ""

if (-not $NoBrowser) {
    try { Start-Process $url | Out-Null } catch { Write-Host "  (open the URL above manually)" }
}

function Send-Response {
    param($stream, [int]$status, [string]$statusText, [string]$contentType, [byte[]]$body)

    $header = "HTTP/1.1 $status $statusText`r`n" +
              "Content-Type: $contentType`r`n" +
              "Content-Length: $($body.Length)`r`n" +
              "Cache-Control: no-store`r`n" +
              "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $client.SendTimeout = 15000
            $stream = $client.GetStream()
            $reader = New-Object System.IO.StreamReader -ArgumentList $stream, ([System.Text.Encoding]::ASCII)

            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

            # Drain the headers so the client is happy.
            while ($true) {
                $line = $reader.ReadLine()
                if ($null -eq $line -or $line -eq '') { break }
            }

            $parts = $requestLine.Split(' ')
            if ($parts.Length -lt 2) { continue }
            $rawPath = $parts[1]

            $query = $rawPath.IndexOf('?')
            if ($query -ge 0) { $rawPath = $rawPath.Substring(0, $query) }
            $rawPath = [System.Uri]::UnescapeDataString($rawPath)
            if ($rawPath -eq '/' -or $rawPath -eq '') { $rawPath = '/index.html' }

            $relative = $rawPath.TrimStart('/').Replace('/', '\')
            $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative))

            if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-Response $stream 403 'Forbidden' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes('Forbidden'))
            } elseif (Test-Path -LiteralPath $target -PathType Leaf) {
                $bytes = [System.IO.File]::ReadAllBytes($target)
                Send-Response $stream 200 'OK' (Get-ContentType $target) $bytes
                Write-Host "  200  $rawPath" -ForegroundColor DarkGray
            } else {
                Send-Response $stream 404 'Not Found' 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes("Not found: $rawPath"))
                Write-Host "  404  $rawPath" -ForegroundColor DarkYellow
            }
        } catch {
            # A browser closing a connection mid-request is normal; keep serving.
        } finally {
            if ($null -ne $client) { $client.Close() }
        }
    }
} finally {
    $listener.Stop()
}
