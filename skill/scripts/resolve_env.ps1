# Resolve PDD skill paths: config.json > env > auto-detect.
# Dot-source or call; sets $PddEnv hashtable.
# Priority documented in references/env.md — keep in sync.

function Get-PddSkillRoot {
  # scripts/ -> skill root
  Split-Path -Parent $PSScriptRoot
}

function Resolve-PddConfig {
  $root = if ($script:PddSkillRoot) { $script:PddSkillRoot } else { Get-PddSkillRoot }
  $script:PddSkillRoot = $root
  $cfgPath = Join-Path $root "config.json"
  $cfg = [ordered]@{
    chrome = ""; chrome_profile = ""; node = ""; npm = ""; python = ""
    playwright_core = ""; workdir = ""; default_port = 9222; reuse_profile = $true
  }
  if (Test-Path $cfgPath) {
    try {
      $raw = Get-Content $cfgPath -Raw | ConvertFrom-Json
      foreach ($k in @('chrome','chrome_profile','node','npm','python','playwright_core','workdir')) {
        if ($raw.PSObject.Properties.Name -contains $k -and $raw.$k) { $cfg[$k] = [string]$raw.$k }
      }
      if ($raw.PSObject.Properties.Name -contains 'default_port' -and $raw.default_port) {
        $cfg.default_port = [int]$raw.default_port
      }
      if ($raw.PSObject.Properties.Name -contains 'reuse_profile') {
        $cfg.reuse_profile = [bool]$raw.reuse_profile
      }
    } catch {}
  }
  return $cfg
}

function Resolve-PddEnv {
  $cfg = Resolve-PddConfig
  $envMap = @{}

  # Node
  $envMap.node = if ($cfg.node -and (Test-Path $cfg.node)) { $cfg.node }
    elseif ($env:PDD_NODE -and (Test-Path $env:PDD_NODE)) { $env:PDD_NODE }
    else {
      $c = Get-Command node -ErrorAction SilentlyContinue
      if ($c) { $c.Source } else { "" }
    }

  # Python
  $envMap.python = if ($cfg.python -and (Test-Path $cfg.python)) { $cfg.python }
    elseif ($env:PDD_PYTHON -and (Test-Path $env:PDD_PYTHON)) { $env:PDD_PYTHON }
    elseif ($env:MIMO_PYTHON -and (Test-Path $env:MIMO_PYTHON)) { $env:MIMO_PYTHON }
    else {
      $c = Get-Command python -ErrorAction SilentlyContinue
      if ($c) { $c.Source } else { "" }
    }

  # Chrome
  $envMap.chrome = if ($cfg.chrome -and (Test-Path $cfg.chrome)) { $cfg.chrome }
    elseif ($env:PDD_CHROME -and (Test-Path $env:PDD_CHROME)) { $env:PDD_CHROME }
    else {
      $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
      )
      $hit = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($hit) { $hit } else { "" }
    }

  # playwright-core path (for Node require)
  $envMap.playwright_core = if ($cfg.playwright_core -and (Test-Path $cfg.playwright_core)) { $cfg.playwright_core }
    elseif ($env:PDD_PLAYWRIGHT -and (Test-Path $env:PDD_PLAYWRIGHT)) { $env:PDD_PLAYWRIGHT }
    else { "playwright-core" }  # bare name → Node require(); caller may set PDD_PLAYWRIGHT

  # Propagate resolved playwright path for Node step scripts
  if ($envMap.playwright_core -and $envMap.playwright_core -ne 'playwright-core') {
    $env:PDD_PLAYWRIGHT = $envMap.playwright_core
  }

  # npm
  $envMap.npm = if ($cfg.npm -and (Test-Path $cfg.npm)) { $cfg.npm }
    elseif ($env:PDD_NPM -and (Test-Path $env:PDD_NPM)) { $env:PDD_NPM }
    else { "" }

  # workdir
  $envMap.workdir = if ($cfg.workdir -and $cfg.workdir.Trim()) { $cfg.workdir }
    elseif ($env:PDD_WORKDIR -and $env:PDD_WORKDIR.Trim()) { $env:PDD_WORKDIR }
    else { Join-Path (Get-Location) "output\playwright\pdd" }

  $envMap.default_port = $cfg.default_port
  $envMap.chrome_profile = if ($cfg.chrome_profile -and $cfg.chrome_profile.Trim()) { $cfg.chrome_profile } else { "" }
  $envMap.reuse_profile = $cfg.reuse_profile
  $envMap.skill_root = $script:PddSkillRoot
  $envMap.read_excel = Join-Path $script:PddSkillRoot "scripts\read_excel.py"
  $envMap.open_browser = Join-Path $script:PddSkillRoot "scripts\open_browser.ps1"
  $envMap.flow_js = Join-Path $script:PddSkillRoot "scripts\pdd_flow.js"

  $script:PddEnv = $envMap
  return $envMap
}

function Show-PddEnv {
  $e = if ($script:PddEnv) { $script:PddEnv } else { Resolve-PddEnv }
  $e.GetEnumerator() | Sort-Object Name | ForEach-Object {
    "{0,-16} {1}" -f $_.Key, $_.Value
  }
}

# Auto-resolve on dot-source
Resolve-PddEnv | Out-Null
