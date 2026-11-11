# Steak DSH installer for Windows:  irm https://github.com/michael-berardi/steak-dsh/releases/latest/download/install.ps1 | iex
# One step, whole bundle: checks the release SHA-256, installs Steak DSH, brings Node 22+ when missing (official build,
# kept in Steak DSH's own folder), installs DeepSeek Harness (dsh) when missing, adds the bundle to the dsh "headless"
# profile, and puts `steak-dsh` on your PATH. No admin rights, re-running upgrades.
# Also runs under PowerShell 7 on Linux and macOS (used by the tests): the Windows-only parts (user Path, junctions,
# .cmd shims) are guarded, and POSIX shims are written there instead.
# Environment: STEAK_DSH_HOME (default %LOCALAPPDATA%\steak-dsh), STEAK_DSH_BIN_DIR (default <home>\bin on Windows,
# ~/.local/bin elsewhere), STEAK_DSH_VERSION (pin a release), STEAK_DSH_RELEASE_BASE (override the download base URL,
# used by tests), STEAK_DSH_DSH_VERSION (the dsh version to install when missing, default 0.2.2-rc.1).
$ErrorActionPreference = 'Stop'

function Install-SteakDsh {
  $repo = 'michael-berardi/steak-dsh'
  $nodeMinMajor = 22
  $dshMin = '0.2.2-rc.1'
  $dshVersion = if ($env:STEAK_DSH_DSH_VERSION) { $env:STEAK_DSH_DSH_VERSION } else { '0.2.2-rc.1' }
  $onWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
  $homeDir = if ($env:STEAK_DSH_HOME) { $env:STEAK_DSH_HOME }
  elseif ($onWindows) { Join-Path $env:LOCALAPPDATA 'steak-dsh' }
  else { Join-Path $HOME '.steak-dsh' }
  $binDir = if ($env:STEAK_DSH_BIN_DIR) { $env:STEAK_DSH_BIN_DIR }
  elseif ($onWindows) { Join-Path $homeDir 'bin' }
  else { Join-Path $HOME '.local/bin' }
  $base = if ($env:STEAK_DSH_RELEASE_BASE) { $env:STEAK_DSH_RELEASE_BASE }
  elseif ($env:STEAK_DSH_VERSION) { "https://github.com/$repo/releases/download/v$($env:STEAK_DSH_VERSION.TrimStart('v'))" }
  else { "https://github.com/$repo/releases/latest/download" }
  $app = Join-Path $homeDir 'app'

  # Run a native command without $ErrorActionPreference='Stop' turning its stderr into a terminating error.
  function Invoke-Tool {
    param([string]$Exe, [string[]]$ToolArgs = @(), [switch]$Capture)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = ''
    try {
      if ($Capture) { $out = (& $Exe @ToolArgs 2>&1 | ForEach-Object { "$_" }) -join "`n" }
      else { & $Exe @ToolArgs | Out-Host }
      $code = $LASTEXITCODE
    } catch {
      $code = 1
      $out = "$_"
    } finally { $ErrorActionPreference = $prev }
    return [pscustomobject]@{ Code = $code; Output = $out }
  }

  function Get-RemoteFile {
    param([string]$Url, [string]$OutFile)
    try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing }
    catch { throw "download failed: $Url ($($_.Exception.Message))" }
  }

  # Assert-Checksum <file> <name> <sums-file>: the file's SHA-256 must equal the line for <name> in the sums file.
  function Assert-Checksum {
    param([string]$File, [string]$Name, [string]$SumsFile)
    $line = Get-Content $SumsFile | Where-Object { $_ -match "^\S+\s+\*?$([regex]::Escape($Name))\s*$" } | Select-Object -First 1
    if (-not $line) { throw "no checksum for $Name in $(Split-Path $SumsFile -Leaf)" }
    $want = ($line -split '\s+')[0].ToLower()
    $got = (Get-FileHash $File -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want) { throw "checksum mismatch for $Name; nothing was installed" }
  }

  function Test-NodeOk {
    param([string]$NodeExe)
    if (-not (Test-Path $NodeExe)) { return $false }
    $r = Invoke-Tool -Exe $NodeExe -ToolArgs @('-p', 'process.versions.node') -Capture
    if ($r.Code -ne 0 -or -not $r.Output) { return $false }
    $major = 0
    if (-not [int]::TryParse($r.Output.Trim().Split('.')[0], [ref]$major)) { return $false }
    return ($major -ge $nodeMinMajor)
  }

  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    throw 'needs tar (built into Windows 10 and later; on Linux install it with your package manager)'
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('steak-dsh-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host 'Downloading Steak DSH...'
    Get-RemoteFile "$base/steak-dsh.tar.gz" (Join-Path $tmp 'steak-dsh.tar.gz')
    Get-RemoteFile "$base/SHA256SUMS" (Join-Path $tmp 'SHA256SUMS')
    Assert-Checksum (Join-Path $tmp 'steak-dsh.tar.gz') 'steak-dsh.tar.gz' (Join-Path $tmp 'SHA256SUMS')
    $src = Join-Path $tmp 'src'
    New-Item -ItemType Directory -Path $src | Out-Null
    $r = Invoke-Tool -Exe 'tar' -ToolArgs @('-xzf', (Join-Path $tmp 'steak-dsh.tar.gz'), '-C', $src)
    if ($r.Code -ne 0) { throw 'cannot unpack the download' }
    if (-not ((Test-Path (Join-Path $src 'package.json')) -and (Test-Path (Join-Path $src 'cordis.patch.yml')) -and (Test-Path (Join-Path $src 'bin/steak-dsh')))) {
      throw 'the download is not a Steak DSH release'
    }
    $pkg = Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json
    $version = $pkg.version
    if (-not $version) { throw 'cannot read the release version' }

    # Node: the one on PATH when it is new enough, else the official build, kept inside Steak DSH's own folder.
    $nodeExe = $null
    $nodePrivate = $false
    $privateNode = if ($onWindows) { Join-Path $homeDir 'node\node.exe' } else { Join-Path $homeDir 'node/bin/node' }
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    if ($systemNode -and (Test-NodeOk $systemNode.Source)) {
      $nodeExe = $systemNode.Source
      # A private Node that happens to be on PATH (a re-run in the same session) stays private,
      # so the shims keep working in terminals without it.
      if ($nodeExe -eq $privateNode) { $nodePrivate = $true }
    }
    if (-not $nodeExe -and (Test-NodeOk $privateNode)) { $nodeExe = $privateNode; $nodePrivate = $true }
    if (-not $nodeExe) {
      if ($onWindows) {
        $os = 'win'
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $ext = 'zip'
      } else {
        $os = if ($IsMacOS) { 'darwin' } else { 'linux' }
        $arch = if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'x64' }
        $ext = 'tar.gz'
      }
      Write-Host "Node $nodeMinMajor or newer not found; fetching the official Node 22 LTS for $os-$arch..."
      $nbase = 'https://nodejs.org/dist/latest-v22.x'
      Get-RemoteFile "$nbase/SHASUMS256.txt" (Join-Path $tmp 'NODESUMS')
      $nname = Get-Content (Join-Path $tmp 'NODESUMS') | ForEach-Object { ($_ -split '\s+')[1] } |
        Where-Object { $_ -like "*-$os-$arch.$ext" } | Select-Object -First 1
      if (-not $nname) { throw "no official Node build for $os-$arch" }
      Get-RemoteFile "$nbase/$nname" (Join-Path $tmp $nname)
      Assert-Checksum (Join-Path $tmp $nname) $nname (Join-Path $tmp 'NODESUMS')
      New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
      $nodeDir = Join-Path $homeDir 'node'
      $nodeTmp = Join-Path $homeDir 'node.tmp'
      if (Test-Path $nodeTmp) { Remove-Item -Recurse -Force $nodeTmp }
      New-Item -ItemType Directory -Path $nodeTmp | Out-Null
      if ($ext -eq 'zip') {
        Expand-Archive -Path (Join-Path $tmp $nname) -DestinationPath $nodeTmp
        $inner = Get-ChildItem $nodeTmp | Select-Object -First 1
        if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
        Move-Item $inner.FullName $nodeDir
        Remove-Item -Recurse -Force $nodeTmp
      } else {
        $r = Invoke-Tool -Exe 'tar' -ToolArgs @('-xzf', (Join-Path $tmp $nname), '-C', $nodeTmp, '--strip-components=1')
        if ($r.Code -ne 0) { throw 'cannot unpack Node' }
        if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
        Move-Item $nodeTmp $nodeDir
      }
      $nodeExe = $privateNode
      $nodePrivate = $true
      if (-not (Test-NodeOk $nodeExe)) { throw 'the downloaded Node does not run on this machine' }
    }
    $nodeDir = Split-Path $nodeExe -Parent
    $env:PATH = "$nodeDir$([IO.Path]::PathSeparator)$env:PATH"
    $npm = if ($onWindows) { Join-Path $nodeDir 'npm.cmd' } else { Join-Path $nodeDir 'npm' }
    if (-not (Test-Path $npm)) { throw "npm was not found next to Node ($nodeExe); install npm, then run this again" }

    # ver_ge <version> <min>: semver >= with prerelease rules, checked with the Node we just resolved.
    $verJs = Join-Path $tmp 'ver_ge.js'
    @'
const parse = (t) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(t).trim());
  if (!m) process.exit(2);
  return [+m[1], +m[2], +m[3], m[4] ? m[4].split(".") : null];
};
const cmpPre = (a, b) => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
const a = parse(process.argv[2]), b = parse(process.argv[3]);
for (let i = 0; i < 3; i++) if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1);
process.exit(cmpPre(a[3], b[3]) >= 0 ? 0 : 1);
'@ | Set-Content -Path $verJs -Encoding UTF8
    function Test-VerGe {
      param([string]$Version, [string]$Min)
      if (-not $Version) { return $false }
      $r = Invoke-Tool -Exe $nodeExe -ToolArgs @($verJs, $Version, $Min) -Capture
      return ($r.Code -eq 0)
    }

    # dsh: a working one on PATH when it is new enough, else a private npm install in Steak DSH's own folder.
    $hadDsh = $null
    $dshBin = $null
    $systemDsh = Get-Command dsh -ErrorAction SilentlyContinue
    if ($systemDsh) {
      $hadDsh = $systemDsh.Source
      if ($onWindows -and $hadDsh.EndsWith('.ps1')) {
        $cmdSibling = $hadDsh.Substring(0, $hadDsh.Length - 4) + '.cmd'
        if (Test-Path $cmdSibling) { $hadDsh = $cmdSibling }
      }
      $r = Invoke-Tool -Exe $hadDsh -ToolArgs @('--version') -Capture
      $dshv = ($r.Output -split "`n")[0].Trim()
      if ($r.Code -eq 0 -and (Test-VerGe $dshv $dshMin)) {
        $dshBin = $hadDsh
        Write-Host "Using the dsh already on PATH: $dshBin ($dshv)."
      } else {
        Write-Host "The dsh on PATH ($hadDsh) does not run or is older than $dshMin; installing a private copy."
      }
    }
    $privDsh = if ($onWindows) { Join-Path $homeDir 'dsh\node_modules\.bin\dsh.cmd' } else { Join-Path $homeDir 'dsh/node_modules/.bin/dsh' }
    $privDshTmp = if ($onWindows) { Join-Path $homeDir 'dsh.tmp\node_modules\.bin\dsh.cmd' } else { Join-Path $homeDir 'dsh.tmp/node_modules/.bin/dsh' }
    if (-not $dshBin -and (Test-Path $privDsh)) {
      $r = Invoke-Tool -Exe $privDsh -ToolArgs @('--version') -Capture
      $pv = ($r.Output -split "`n")[0].Trim()
      if ($r.Code -eq 0 -and (Test-VerGe $pv $dshMin)) {
        $dshBin = $privDsh
        Write-Host "Using the dsh installed earlier: $dshBin ($pv)."
      }
    }
    if (-not $dshBin) {
      Write-Host "Installing DeepSeek Harness (dsh $dshVersion) with npm; about 650 packages, this can take a few minutes..."
      New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
      $dshTmp = Join-Path $homeDir 'dsh.tmp'
      if (Test-Path $dshTmp) { Remove-Item -Recurse -Force $dshTmp }
      $env:npm_config_update_notifier = 'false'; $env:npm_config_fund = 'false'; $env:npm_config_audit = 'false'
      $r = Invoke-Tool -Exe $npm -ToolArgs @('install', '--prefix', $dshTmp, "@deepseek-ai/dsh@$dshVersion", '--no-audit', '--no-fund', '--loglevel=error')
      if ($r.Code -ne 0) {
        Remove-Item -Recurse -Force $dshTmp -ErrorAction SilentlyContinue
        throw "npm could not install @deepseek-ai/dsh@$dshVersion (network or registry problem); nothing was changed"
      }
      if (-not (Test-Path $privDshTmp)) {
        Remove-Item -Recurse -Force $dshTmp -ErrorAction SilentlyContinue
        throw 'the dsh package did not install a dsh command; nothing was changed'
      }
      $dshOld = Join-Path $homeDir 'dsh.old'
      if (Test-Path $dshOld) { Remove-Item -Recurse -Force $dshOld }
      $dshDir = Join-Path $homeDir 'dsh'
      if (Test-Path $dshDir) { Move-Item $dshDir $dshOld }
      Move-Item $dshTmp $dshDir
      if (Test-Path $dshOld) { Remove-Item -Recurse -Force $dshOld }
      $dshBin = $privDsh
      $r = Invoke-Tool -Exe $dshBin -ToolArgs @('--version') -Capture
      $dv = ($r.Output -split "`n")[0].Trim()
      if ($r.Code -ne 0 -or -not (Test-VerGe $dv $dshMin)) {
        throw "the installed dsh does not run (version: '$dv'); it needs Node $nodeMinMajor+; nothing else was changed"
      }
    }

    New-Item -ItemType Directory -Path $app -Force | Out-Null
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null

    # Steak DSH itself: stage, check it starts, then move into place and swap the current link.
    $rel = Join-Path $app "release-$version"
    if (-not (Test-Path $rel)) {
      Write-Host "Installing Steak DSH $version..."
      $relTmp = "$rel.tmp"
      if (Test-Path $relTmp) { Remove-Item -Recurse -Force $relTmp }
      Move-Item $src $relTmp
      $r = Invoke-Tool -Exe $nodeExe -ToolArgs @((Join-Path $relTmp 'bin/steak-dsh'), '--version') -Capture
      if ($r.Code -ne 0) { Remove-Item -Recurse -Force $relTmp; throw "the new copy does not start: $($r.Output)" }
      if ($r.Output.Trim() -notlike "$version*") { Remove-Item -Recurse -Force $relTmp; throw "the new copy reports '$($r.Output)', not $version; nothing was changed" }
      Move-Item $relTmp $rel
    } else {
      Write-Host "Steak DSH $version is already unpacked; relinking."
    }
    $current = Join-Path $app 'current'
    if (Test-Path $current) { (Get-Item $current -Force).Delete() }
    if ($onWindows) { New-Item -ItemType Junction -Path $current -Target $rel | Out-Null }
    else { New-Item -ItemType SymbolicLink -Path $current -Target $rel | Out-Null }
    Get-ChildItem $app -Directory | Where-Object { $_.Name -like 'release-*' -and $_.FullName -ne $rel -and -not $_.LinkType } |
      Remove-Item -Recurse -Force

    # A dsh shim only when no dsh existed on PATH; an existing dsh is never shadowed.
    $nodePathCmd = if ($nodePrivate) { "set `"PATH=$nodeDir;%PATH%`"" } else { $null }
    $nodePathSh = if ($nodePrivate) { 'PATH="' + $nodeDir + ':$PATH"; export PATH' } else { '' }
    if (-not $hadDsh) {
      if ($onWindows) {
        $lines = @('@echo off')
        if ($nodePathCmd) { $lines += $nodePathCmd }
        $lines += "call `"$dshBin`" %*"
        Set-Content -Path (Join-Path $binDir 'dsh.cmd') -Value $lines -Encoding ASCII
      } else {
        $lines = @('#!/bin/sh')
        if ($nodePathSh) { $lines += $nodePathSh }
        $lines += "exec `"$dshBin`" `"`$@`""
        $shim = Join-Path $binDir 'dsh'
        Set-Content -Path $shim -Value $lines -Encoding ASCII
        $r = Invoke-Tool -Exe 'chmod' -ToolArgs @('755', $shim)
        if ($r.Code -ne 0) { throw "cannot make $shim executable" }
      }
    }

    # Add the bundle to the dsh headless profile. dsh needs pnpm for this; bring it privately when missing.
    Write-Host 'Adding Steak DSH to the dsh headless profile...'
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
    $pnpmDir = $null
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
      # already on PATH
    } elseif ((Get-Command corepack -ErrorAction SilentlyContinue) -and
        ((Invoke-Tool -Exe 'corepack' -ToolArgs @('pnpm', '--version') -Capture).Code -eq 0)) {
      $pnpmDir = Join-Path $tmp 'pnpm-bin'
      New-Item -ItemType Directory -Path $pnpmDir | Out-Null
      if ($onWindows) {
        Set-Content -Path (Join-Path $pnpmDir 'pnpm.cmd') -Value @('@echo off', 'corepack pnpm %*') -Encoding ASCII
      } else {
        $shim = Join-Path $pnpmDir 'pnpm'
        Set-Content -Path $shim -Value @('#!/bin/sh', 'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0', 'exec corepack pnpm "$@"') -Encoding ASCII
        $null = Invoke-Tool -Exe 'chmod' -ToolArgs @('755', $shim)
      }
    } else {
      Write-Host "pnpm not found; installing it privately into $(Join-Path $homeDir 'tools') for this step..."
      $r = Invoke-Tool -Exe $npm -ToolArgs @('install', '--prefix', (Join-Path $homeDir 'tools'), 'pnpm', '--no-audit', '--no-fund', '--loglevel=error')
      if ($r.Code -ne 0) { Write-Host 'steak-dsh install: warning: npm could not install pnpm (network or registry problem)' }
      $pnpmDir = Join-Path $homeDir 'tools/node_modules/.bin'
    }
    $savedPath = $env:PATH
    if ($pnpmDir) { $env:PATH = "$pnpmDir$([IO.Path]::PathSeparator)$env:PATH" }
    $r = Invoke-Tool -Exe $dshBin -ToolArgs @('plugin', '--profile', 'headless', 'add', $current)
    $env:PATH = $savedPath
    if ($r.Code -eq 0) {
      Write-Host 'Steak DSH added to the dsh headless profile.'
    } else {
      Write-Host 'steak-dsh install: warning: could not add the bundle to the dsh headless profile; the steak-dsh launcher works without it. Try again later with: steak-dsh install'
    }

    # `steak-dsh` on PATH: points at the dsh we resolved and, when fetched, at the private Node.
    if ($onWindows) {
      $lines = @('@echo off', "if `"%STEAK_DSH_DSH_BIN%`"==`"`" set `"STEAK_DSH_DSH_BIN=$dshBin`"")
      if ($nodePathCmd) { $lines += $nodePathCmd }
      $lines += "node `"$current\bin\steak-dsh`" %*"
      $shim = Join-Path $binDir 'steak-dsh.cmd'
      Set-Content -Path $shim -Value $lines -Encoding ASCII
      $doctorExe = 'cmd.exe'
      $doctorArgs = @('/c', $shim, 'doctor')
    } else {
      $lines = @('#!/bin/sh', "STEAK_DSH_DSH_BIN=`"`${STEAK_DSH_DSH_BIN:-$dshBin}`"", 'export STEAK_DSH_DSH_BIN')
      if ($nodePathSh) { $lines += $nodePathSh }
      $lines += "exec `"$current/bin/steak-dsh`" `"`$@`""
      $shim = Join-Path $binDir 'steak-dsh'
      Set-Content -Path $shim -Value $lines -Encoding ASCII
      $r = Invoke-Tool -Exe 'chmod' -ToolArgs @('755', $shim)
      if ($r.Code -ne 0) { throw "cannot make $shim executable" }
      $doctorExe = $shim
      $doctorArgs = @('doctor')
    }
    Write-Host 'Checking the installation (steak-dsh doctor)...'
    $doctor = Invoke-Tool -Exe $doctorExe -ToolArgs $doctorArgs
    if ($doctor.Code -ne 0) { throw 'steak-dsh doctor failed; see its output above' }

    if ($hadDsh -and $dshBin -eq $hadDsh) { Write-Host 'dsh was already installed: added Steak DSH to it' }
    else { Write-Host 'installed DeepSeek Harness and Steak DSH' }
    Write-Host "Steak DSH $version installed ($(Join-Path $binDir 'steak-dsh'))."
    if ($onWindows) {
      $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
      if (-not (($userPath -split ';') -contains $binDir)) {
        $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $binDir } else { $binDir }
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        Write-Host "Added $binDir to your user PATH; open a new terminal to use steak-dsh."
      }
    } else {
      if (($env:PATH -split [IO.Path]::PathSeparator) -notcontains $binDir) {
        Write-Host ('Add ' + $binDir + ' to your PATH:  export PATH="' + $binDir + ':$PATH"')
      }
    }
    Write-Host 'Next: steak-dsh run "fix the failing test in src/parser"'
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

Install-SteakDsh
