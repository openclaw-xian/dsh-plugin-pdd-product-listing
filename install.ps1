# install.ps1 - install dsh-plugin-pdd-product-listing into a DeepSeek Harness profile
#
# Usage (run inside this plugin folder):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -ProfileDir "C:\Users\you\.dsh\profiles\web"
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Python "C:\Python311\python.exe"
#
# The real work is done by install-core.py next to this file (this plugin requires Python anyway).
# This wrapper only locates Python and calls it WITHOUT passing any path arguments, because
# Windows PowerShell 5.1 does not quote arguments containing spaces when calling native programs.
#
# It does exactly four things: copy the plugin, register it in profile bundles, append plugin
# config, and run a dependency check. It never touches credentials, never starts/stops dsh,
# and never touches your shop Chrome.
#
# NOTE: all messages here are ASCII on purpose - Windows PowerShell 5.1 reads .ps1 files with
# the system code page, so non-ASCII text in a BOM-less script would be garbled.

param(
  [string]$ProfileDir = "",
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

if (-not $Python) {
  foreach ($cand in @("python", "py", "python3")) {
    $c = Get-Command $cand -ErrorAction SilentlyContinue
    if ($c) { $Python = $c.Source; break }
  }
}

if (-not $Python) {
  Write-Host "!! Python not found. This plugin needs Python 3 + openpyxl (to parse the asset-pack Excel)."
  Write-Host "   Install Python, then run this script again. Or install manually:"
  Write-Host "   1) copy this folder to  ~\.dsh\profiles\<profile>\node_modules\dsh-plugin-pdd-product-listing"
  Write-Host "   2) add  dsh-plugin-pdd-product-listing  to that profile's package.json -> dsh.profile.bundles"
  Write-Host "   3) restart DeepSeek Harness"
  exit 1
}

$installer = Join-Path $here "install-core.py"
if (-not (Test-Path $installer)) { throw "install-core.py is missing (it must sit next to this script)" }

# cd into the plugin folder and call with a RELATIVE path: no argument contains a space.
Push-Location $here
try {
  if ($ProfileDir) {
    & $Python "install-core.py" --plugin-dir "." --profile-dir $ProfileDir
  } else {
    & $Python "install-core.py" --plugin-dir "."
  }
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
