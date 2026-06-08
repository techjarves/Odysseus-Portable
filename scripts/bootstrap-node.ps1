param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$NodeDir
)

$ErrorActionPreference = "Stop"

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$zipName = "node-v$Version-win-$arch.zip"
$url = "https://nodejs.org/dist/v$Version/$zipName"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tmp = Join-Path $projectRoot "data\bootstrap\node"
$zipPath = Join-Path $tmp $zipName

New-Item -ItemType Directory -Force -Path $tmp, $NodeDir | Out-Null

Write-Host "[Bootstrap] Downloading Node.js $Version ($arch)..."
Add-Type -AssemblyName System.Net.Http
$client = [System.Net.Http.HttpClient]::new()
$response = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
$response.EnsureSuccessStatusCode() | Out-Null
$total = $response.Content.Headers.ContentLength
$stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
$file = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$buffer = New-Object byte[] (1024 * 1024)
$downloaded = 0L
$started = Get-Date
$lastShown = Get-Date
try {
  while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $file.Write($buffer, 0, $read)
    $downloaded += $read
    $now = Get-Date
    if (($now - $lastShown).TotalMilliseconds -ge 350 -or ($total -and $downloaded -eq $total)) {
      $elapsed = [Math]::Max(($now - $started).TotalSeconds, 0.001)
      $mb = $downloaded / 1MB
      $speed = $mb / $elapsed
      if ($total) {
        $pct = [Math]::Min(100, ($downloaded / $total) * 100)
        $totalMb = $total / 1MB
        Write-Host ("`r[Bootstrap] Downloading: {0,6:N1}%  {1:N1}/{2:N1} MB  {3:N1} MB/s" -f $pct, $mb, $totalMb, $speed) -NoNewline
      } else {
        Write-Host ("`r[Bootstrap] Downloading: {0:N1} MB  {1:N1} MB/s" -f $mb, $speed) -NoNewline
      }
      $lastShown = $now
    }
  }
} finally {
  $file.Close()
  $stream.Close()
  $client.Dispose()
}
Write-Host ""

Write-Host "[Bootstrap] Extracting Node.js..."
$extractJob = Start-Job -ScriptBlock {
  param($zip, $tmpDir, $dest)
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
  $root = Get-ChildItem -Path $tmpDir -Directory | Where-Object { $_.Name -like "node-v*" } | Select-Object -First 1
  if (-not $root) { throw "Node archive did not contain a node-v* folder." }
  Get-ChildItem -Path $dest -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -Path (Join-Path $root.FullName "*") -Destination $dest -Recurse -Force
} -ArgumentList $zipPath, $tmp, $NodeDir

$spinner = @("|", "/", "-", "\")
$i = 0
while ($extractJob.State -eq "Running") {
  Write-Host ("`r[Bootstrap] Extracting: {0}" -f $spinner[$i % $spinner.Length]) -NoNewline
  $i++
  Start-Sleep -Milliseconds 150
}
Write-Host "`r[Bootstrap] Extracting: done "
Receive-Job $extractJob
Remove-Job $extractJob
Remove-Item -Path $tmp -Recurse -Force
Write-Host "[Bootstrap] Portable Node.js is ready."
