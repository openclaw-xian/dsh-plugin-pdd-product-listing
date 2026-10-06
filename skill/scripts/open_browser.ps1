param(
  [string]$WorkDir = "",
  [int]$Port = 0,
  [string]$StartUrl = "https://mms.pinduoduo.com",
  [string]$Profile = "",
  [switch]$ForceNewProfile
)

# Resolve paths via shared helper (config > env > detect)
. (Join-Path $PSScriptRoot "resolve_env.ps1")
$e = $script:PddEnv

if ($Port -eq 0) { $Port = [int]$e.default_port }
if (-not $WorkDir) { $WorkDir = $e.workdir }
if (-not $Profile) { $Profile = $e.chrome_profile }

$chrome = $e.chrome
if (-not $chrome) {
  Write-Error "Chrome not found. Set chrome in config.json or PDD_CHROME env."
  exit 1
}

New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

# Profile priority:
# 1) -Profile param / config.chrome_profile (prefer user's logged-in store profile)
# 2) reuse_profile=true + existing default under workdir
# 3) fresh profile under workdir (only if ForceNewProfile or no prior login env)
$userDataArgs = @()
if ($Profile -and (Test-Path $Profile)) {
  $userDataArgs = @("--user-data-dir=$Profile")
  Write-Host "PROFILE reuse explicit: $Profile"
} elseif (-not $ForceNewProfile -and $e.reuse_profile) {
  $defaultProfile = Join-Path $WorkDir "chrome-profile"
  if (Test-Path (Join-Path $defaultProfile "Default")) {
    $userDataArgs = @("--user-data-dir=$defaultProfile")
    Write-Host "PROFILE reuse existing: $defaultProfile"
  } else {
    New-Item -ItemType Directory -Path $defaultProfile -Force | Out-Null
    $userDataArgs = @("--user-data-dir=$defaultProfile")
    Write-Host "PROFILE create (first run, will need login): $defaultProfile"
  }
} else {
  $defaultProfile = Join-Path $WorkDir "chrome-profile-fresh"
  New-Item -ItemType Directory -Path $defaultProfile -Force | Out-Null
  $userDataArgs = @("--user-data-dir=$defaultProfile")
  Write-Host "PROFILE fresh (ForceNewProfile): $defaultProfile"
}

# If CDP already healthy, do not spawn a second Chrome
try {
  $existing = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 3
  if ($existing.StatusCode -eq 200) {
    Write-Host "CDP_OK already port=$Port"
    exit 0
  }
} catch {}

$argList = @(
  "--remote-debugging-port=$Port"
) + $userDataArgs + @(
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1400,900",
  $StartUrl
)

Start-Process -FilePath $chrome -ArgumentList $argList
Start-Sleep -Seconds 3

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 5
  Write-Host "CDP_OK port=$Port"
} catch {
  Write-Error "CDP not ready on port $Port"
  exit 2
}
