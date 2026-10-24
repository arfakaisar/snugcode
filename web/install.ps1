# snugcode installer for Windows (PowerShell):  irm https://snugcode.dev/install.ps1 | iex
# Checks Node.js 22+ & git, installs snugcode, then runs `snugcode setup`.
$ErrorActionPreference = 'Stop'
function Die($m) { Write-Host "x $m" -ForegroundColor Red; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die 'git is not installed: winget install Git.Git, then open a new PowerShell.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js is not installed: winget install OpenJS.NodeJS.LTS, then open a new PowerShell.' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { Die "Node.js $(node -v) is too old; snugcode needs 22+. winget upgrade OpenJS.NodeJS.LTS" }
# Always from the official GitHub repo (latest release tag, or main before the first release). The npm registry is
# deliberately not asked whether a package named snugcode exists: an unclaimed name can be registered by anyone.
$spec = if ($env:SNUGCODE_PACKAGE) { $env:SNUGCODE_PACKAGE } else { 'github:arfakaisar/snugcode#semver:*' }
Write-Host "-> Installing snugcode ($spec)..."
npm i -g $spec --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0 -and -not $env:SNUGCODE_PACKAGE) { npm i -g github:arfakaisar/snugcode --no-audit --no-fund --loglevel=error }
if ($LASTEXITCODE -ne 0) { Die 'Install failed (see the npm messages above).' }
Write-Host 'v snugcode installed. Running setup...' -ForegroundColor Green
if ($env:SNUGCODE_RELAY) { snugcode setup --relay $env:SNUGCODE_RELAY } else { snugcode setup }
