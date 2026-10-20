# Pemasang snugcode untuk Windows (PowerShell):  irm https://snugcode.arfak.workers.dev/install.ps1 | iex
# Memeriksa Node.js 22+ & git, memasang snugcode, lalu menjalankan `snugcode setup`.
$ErrorActionPreference = 'Stop'
function Die($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git belum terpasang: winget install Git.Git, lalu buka PowerShell baru.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js belum terpasang: winget install OpenJS.NodeJS.LTS, lalu buka PowerShell baru.' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { Die "Node.js $(node -v) terlalu lama; snugcode butuh 22+. winget upgrade OpenJS.NodeJS.LTS" }
npm view snugcode version *> $null
$spec = if ($LASTEXITCODE -eq 0) { 'snugcode' } else { 'github:arfakaisar/snugcode#semver:*' }
Write-Host "-> Memasang snugcode ($spec)..."
npm i -g $spec --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { npm i -g github:arfakaisar/snugcode --no-audit --no-fund --loglevel=error }
if ($LASTEXITCODE -ne 0) { Die 'Pemasangan gagal (lihat pesan npm di atas).' }
Write-Host 'v snugcode terpasang. Menjalankan setup...' -ForegroundColor Green
if ($env:SNUGCODE_RELAY) { snugcode setup --relay $env:SNUGCODE_RELAY } else { snugcode setup }
