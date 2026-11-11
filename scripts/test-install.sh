#!/usr/bin/env bash
# Tests for the one-step installers, against a local release folder served over HTTP.
# Covers: macOS (this machine), Linux (ubuntu:24.04 container, both dsh branches), and install.ps1
# under PowerShell 7 in the mcr.microsoft.com/powershell container (no Node in that image: the
# script fetching Node itself is part of what is tested). Needs: docker, python3, node, shellcheck, network.
# Usage: scripts/test-install.sh          (commit first: build-release.sh builds from a clean tree)
# STEAK_DSH_TEST_SKIP=mac,linux,pwsh skips sections; STEAK_DSH_TEST_PORT sets the server port.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
WORK="$ROOT/.scratch/install-tests"
PORT="${STEAK_DSH_TEST_PORT:-18473}"
BASE="http://127.0.0.1:$PORT"
DOCKER_BASE="http://host.docker.internal:$PORT"
SKIP=",${STEAK_DSH_TEST_SKIP:-},"
VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
SERVER_PID=""

say() { printf '\n=== %s ===\n' "$*"; }
fail() { printf 'TEST FAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
    if python3 - "$PORT" <<'PY'
import socket, sys
s = socket.socket()
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    sys.exit(1)  # still accepting connections: not released
except OSError:
    sys.exit(0)
finally:
    s.close()
PY
    then echo "release server stopped; port $PORT is free"; else fail "port $PORT is still in use"; fi
  fi
}
trap cleanup EXIT

rm -rf "$WORK"
mkdir -p "$WORK/tmp" "$WORK/logs" "$WORK/serve/good" "$WORK/serve/bad" "$WORK/empty-bin"
# Keep every temporary write (mktemp, npm cache) inside the worktree.
export TMPDIR="$WORK/tmp"
export npm_config_cache="$ROOT/.scratch/npm-cache"

say "shellcheck"
shellcheck scripts/install.sh scripts/build-release.sh

say "repo tests (node --test, the npm test command)"
node -p 'process.versions.node' >/dev/null 2>&1 || fail "no working node on PATH to run the repo tests; install Node 22+"
node --test test/*.test.js >"$WORK/logs/repo-tests.log" 2>&1 || { tail -20 "$WORK/logs/repo-tests.log"; fail "repo tests"; }
grep -E '^# (tests|pass|fail)' "$WORK/logs/repo-tests.log"

say "build release assets"
scripts/build-release.sh dist/release

cp dist/release/* "$WORK/serve/good/"
cp dist/release/* "$WORK/serve/bad/"
printf 'corrupted' >> "$WORK/serve/bad/steak-dsh.tar.gz"   # checksums no longer match

python3 -m http.server "$PORT" --bind 0.0.0.0 --directory "$WORK/serve" >"$WORK/logs/server.log" 2>&1 &
SERVER_PID=$!
sleep 1
curl -fsS "$BASE/good/SHA256SUMS" >/dev/null || fail "release server did not start on port $PORT"

# Shared npm cache (also warm from earlier runs) keeps the dsh installs quick; it stays in the worktree.

# expect_ok <log> <needle>: the log must contain the needle.
expect_ok() { grep -q "$2" "$1" || { tail -25 "$1"; fail "expected '$2' in $1"; }; }

# ---------------------------------------------------------------- macOS
if [ "$(uname -s)" = Darwin ] && [[ "$SKIP" != *,mac,* ]]; then
  say "macOS branch A: no dsh, no Node on PATH (installer fetches both)"
  H="$WORK/mac-a"; mkdir -p "$H/home"
  env -i HOME="$H/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$WORK/tmp" \
    npm_config_cache="$npm_config_cache" STEAK_DSH_RELEASE_BASE="$BASE/good" \
    STEAK_DSH_HOME="$H/home/.steak-dsh" STEAK_DSH_BIN_DIR="$H/bin" \
    sh scripts/install.sh >"$WORK/logs/mac-a.log" 2>&1 || { tail -30 "$WORK/logs/mac-a.log"; fail "macOS branch A install"; }
  expect_ok "$WORK/logs/mac-a.log" "installed DeepSeek Harness and Steak DSH"
  [ -x "$H/bin/dsh" ] || fail "macOS branch A: no dsh shim was written"
  got=$(PATH="/usr/bin:/bin" "$H/bin/steak-dsh" --version) || fail "macOS branch A: steak-dsh does not run"
  [ "$got" = "$VERSION" ] || fail "macOS branch A: version '$got' != $VERSION"
  PATH="/usr/bin:/bin" "$H/bin/steak-dsh" doctor >"$WORK/logs/mac-a-doctor.log" 2>&1 || fail "macOS branch A: doctor"
  tail -4 "$WORK/logs/mac-a.log"

  say "macOS: re-run upgrades in place"
  env -i HOME="$H/home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$WORK/tmp" \
    npm_config_cache="$npm_config_cache" STEAK_DSH_RELEASE_BASE="$BASE/good" \
    STEAK_DSH_HOME="$H/home/.steak-dsh" STEAK_DSH_BIN_DIR="$H/bin" \
    sh scripts/install.sh >"$WORK/logs/mac-rerun.log" 2>&1 || { tail -30 "$WORK/logs/mac-rerun.log"; fail "macOS re-run"; }
  expect_ok "$WORK/logs/mac-rerun.log" "already unpacked; relinking"
  got=$(PATH="/usr/bin:/bin" "$H/bin/steak-dsh" --version)
  [ "$got" = "$VERSION" ] || fail "macOS re-run: version '$got' != $VERSION"

  say "macOS branch B: a working dsh already on PATH (and a new-enough Node)"
  H2="$WORK/mac-b"; mkdir -p "$H2/home"
  env -i HOME="$H2/home" PATH="$H/home/.steak-dsh/node/bin:$H/bin:/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="$WORK/tmp" \
    npm_config_cache="$npm_config_cache" STEAK_DSH_RELEASE_BASE="$BASE/good" \
    STEAK_DSH_HOME="$H2/home/.steak-dsh" STEAK_DSH_BIN_DIR="$H2/bin" \
    sh scripts/install.sh >"$WORK/logs/mac-b.log" 2>&1 || { tail -30 "$WORK/logs/mac-b.log"; fail "macOS branch B install"; }
  expect_ok "$WORK/logs/mac-b.log" "dsh was already installed: added Steak DSH to it"
  [ ! -e "$H2/bin/dsh" ] || fail "macOS branch B: a dsh shim was written over an existing dsh"
  [ ! -d "$H2/home/.steak-dsh/dsh" ] || fail "macOS branch B: a private dsh was installed although one was on PATH"
  got=$(PATH="$H/home/.steak-dsh/node/bin:$H/bin:/usr/bin:/bin" "$H2/bin/steak-dsh" --version)
  [ "$got" = "$VERSION" ] || fail "macOS branch B: version '$got' != $VERSION"
  tail -4 "$WORK/logs/mac-b.log"

  say "macOS: corrupted archive is refused, nothing installed"
  H3="$WORK/mac-bad"; mkdir -p "$H3/home"
  if env -i HOME="$H3/home" PATH="/usr/bin:/bin" TMPDIR="$WORK/tmp" STEAK_DSH_RELEASE_BASE="$BASE/bad" \
    STEAK_DSH_HOME="$H3/home/.steak-dsh" STEAK_DSH_BIN_DIR="$H3/bin" \
    sh scripts/install.sh >"$WORK/logs/mac-bad.log" 2>&1; then fail "corrupted archive was accepted"; fi
  expect_ok "$WORK/logs/mac-bad.log" "checksum mismatch"
  [ ! -e "$H3/bin/steak-dsh" ] && [ ! -d "$H3/home/.steak-dsh/app" ] || fail "corrupted archive left an install behind"

  say "macOS: missing prerequisite is named"
  if env -i HOME="$WORK/mac-a/home" PATH="$WORK/empty-bin" STEAK_DSH_RELEASE_BASE="$BASE/good" \
    /bin/sh scripts/install.sh >"$WORK/logs/mac-nopreq.log" 2>&1; then fail "missing curl/wget was accepted"; fi
  expect_ok "$WORK/logs/mac-nopreq.log" "needs curl or wget"
fi

# ---------------------------------------------------------------- Linux containers
if [[ "$SKIP" != *,linux,* ]]; then
  say "Linux branch A: ubuntu:24.04, no Node, no dsh (installer fetches both)"
  docker run --rm --name steak-dsh-test-linux-a -v "$ROOT/scripts:/scripts:ro" -v "$npm_config_cache:/npmcache" \
    -e STEAK_DSH_RELEASE_BASE="$DOCKER_BASE/good" -e npm_config_cache=/npmcache \
    ubuntu:24.04 bash -c '
      set -e
      apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
      sh /scripts/install.sh
      export PATH="$HOME/.local/bin:$PATH"
      steak-dsh --version
      steak-dsh doctor
      test -x "$HOME/.local/bin/dsh" || { echo "no dsh shim written"; exit 1; }
      echo "--- re-run (upgrade) ---"
      sh /scripts/install.sh
      steak-dsh --version
      echo "--- corrupted archive ---"
      if STEAK_DSH_RELEASE_BASE="'"$DOCKER_BASE"'/bad" sh /scripts/install.sh; then echo "corrupted archive accepted"; exit 1; fi
      echo "--- missing prerequisite ---"
      mkdir -p /empty-bin
      if env PATH=/empty-bin /bin/sh /scripts/install.sh; then echo "missing curl accepted"; exit 1; fi
      echo LINUX-A-OK
    ' >"$WORK/logs/linux-a.log" 2>&1 || { tail -40 "$WORK/logs/linux-a.log"; fail "Linux branch A"; }
  expect_ok "$WORK/logs/linux-a.log" "installed DeepSeek Harness and Steak DSH"
  expect_ok "$WORK/logs/linux-a.log" "checksum mismatch"
  expect_ok "$WORK/logs/linux-a.log" "needs curl or wget"
  expect_ok "$WORK/logs/linux-a.log" "LINUX-A-OK"
  tail -6 "$WORK/logs/linux-a.log"

  say "Linux branch B: ubuntu:24.04 with Node 22 and dsh preinstalled"
  docker run --rm --name steak-dsh-test-linux-b -v "$ROOT/scripts:/scripts:ro" -v "$npm_config_cache:/npmcache" \
    -e STEAK_DSH_RELEASE_BASE="$DOCKER_BASE/good" -e npm_config_cache=/npmcache \
    ubuntu:24.04 bash -c '
      set -e
      apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null
      arch=$(uname -m); case "$arch" in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; esac
      curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o /tmp/sums
      n=$(awk -v s="-linux-$arch.tar.gz" "index(\$2, s) { print \$2 }" /tmp/sums | head -n 1)
      curl -fsSL "https://nodejs.org/dist/latest-v22.x/$n" -o "/tmp/$n"
      mkdir -p /opt/node && tar -xzf "/tmp/$n" -C /opt/node --strip-components=1
      export PATH=/opt/node/bin:$PATH
      npm install -g @deepseek-ai/dsh@0.2.2-rc.1 --no-audit --no-fund --loglevel=error
      dsh --version
      sh /scripts/install.sh
      export PATH="$HOME/.local/bin:$PATH"
      steak-dsh --version
      steak-dsh doctor
      test ! -e "$HOME/.local/bin/dsh" || { echo "dsh shim written over an existing dsh"; exit 1; }
      test ! -d "$HOME/.steak-dsh/dsh" || { echo "private dsh installed although one was on PATH"; exit 1; }
      echo LINUX-B-OK
    ' >"$WORK/logs/linux-b.log" 2>&1 || { tail -40 "$WORK/logs/linux-b.log"; fail "Linux branch B"; }
  expect_ok "$WORK/logs/linux-b.log" "dsh was already installed: added Steak DSH to it"
  expect_ok "$WORK/logs/linux-b.log" "LINUX-B-OK"
  tail -6 "$WORK/logs/linux-b.log"
fi

# ---------------------------------------------------------------- PowerShell 7 (Linux container)
if [[ "$SKIP" != *,pwsh,* ]]; then
  say "pwsh: install.ps1 in mcr.microsoft.com/powershell (no Node in the image)"
  # The powershell image ships only amd64 and armv7 (no arm64), so pin the amd64 variant by digest:
  # native on x64 hosts, emulated on arm64 hosts (slower; the dsh npm install can take several minutes).
  PWSH_IMAGE="steak-dsh-pwsh-test:amd64"
  if [ "$(docker image inspect "$PWSH_IMAGE" --format '{{.Architecture}}' 2>/dev/null || true)" != amd64 ]; then
    pwsh_digest=$(docker manifest inspect mcr.microsoft.com/powershell:latest \
      | python3 -c 'import json,sys; m=json.load(sys.stdin); print(next(x["digest"] for x in m["manifests"] if x["platform"]["architecture"]=="amd64" and x["platform"]["os"]=="linux"))') \
      || fail "cannot resolve the amd64 powershell image digest"
    docker pull "mcr.microsoft.com/powershell@$pwsh_digest" || fail "cannot pull the amd64 powershell image"
    docker tag "mcr.microsoft.com/powershell@$pwsh_digest" "$PWSH_IMAGE"
  fi
  # shellcheck disable=SC2016  # single quotes are deliberate: this is PowerShell, not shell
  # NODE_OPTIONS caps the Node heap: under x64 emulation on a small Docker VM the dsh npm install
  # can otherwise be OOM-killed when other containers are busy.
  docker run --rm --name steak-dsh-test-pwsh --platform linux/amd64 -v "$ROOT/scripts:/scripts:ro" -v "$npm_config_cache:/npmcache" \
    -e STEAK_DSH_RELEASE_BASE="$DOCKER_BASE/good" -e npm_config_cache=/npmcache \
    -e NODE_OPTIONS=--max-old-space-size=768 \
    "$PWSH_IMAGE" pwsh -NoProfile -Command '
      $ErrorActionPreference = "Stop"
      & /scripts/install.ps1
      $v = & "$HOME/.local/bin/steak-dsh" --version
      if ($LASTEXITCODE -ne 0) { throw "steak-dsh does not run" }
      Write-Host "version: $v"
      & "$HOME/.local/bin/steak-dsh" doctor
      if ($LASTEXITCODE -ne 0) { throw "doctor failed" }
      if (-not (Test-Path "$HOME/.local/bin/dsh")) { throw "no dsh shim written" }
      Write-Host "--- re-run (upgrade) ---"
      & /scripts/install.ps1
      Write-Host "--- shims work in a fresh environment (no Node on PATH) ---"
      & /usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin "$HOME/.local/bin/steak-dsh" --version
      if ($LASTEXITCODE -ne 0) { throw "steak-dsh shim broken after re-run" }
      & /usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin "$HOME/.local/bin/dsh" --version
      if ($LASTEXITCODE -ne 0) { throw "dsh shim broken after re-run" }
      Write-Host "--- corrupted archive ---"
      $env:STEAK_DSH_RELEASE_BASE = "'"${DOCKER_BASE}"'/bad"
      $env:STEAK_DSH_HOME = "$HOME/bad-home"
      $env:STEAK_DSH_BIN_DIR = "$HOME/bad-bin"
      try { & /scripts/install.ps1 } catch { Write-Host "refused: $($_.Exception.Message)"; if ($_.Exception.Message -notmatch "checksum mismatch") { throw }; exit 0 }
      throw "corrupted archive was accepted"
    ' >"$WORK/logs/pwsh.log" 2>&1 || { tail -40 "$WORK/logs/pwsh.log"; fail "pwsh install.ps1"; }
  expect_ok "$WORK/logs/pwsh.log" "installed DeepSeek Harness and Steak DSH"
  expect_ok "$WORK/logs/pwsh.log" "refused: checksum mismatch"
  tail -6 "$WORK/logs/pwsh.log"

  say "pwsh: PSScriptAnalyzer (skipped when it does not install quickly)"
  TIMEOUT_CMD=$(command -v timeout || command -v gtimeout || true)
  # shellcheck disable=SC2016  # single quotes are deliberate: this is PowerShell, not shell
  if ${TIMEOUT_CMD:+$TIMEOUT_CMD 300} docker run --rm --name steak-dsh-test-psanalyzer --platform linux/amd64 -v "$ROOT/scripts:/scripts:ro" "$PWSH_IMAGE" \
    pwsh -NoProfile -Command '
      Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -ErrorAction Stop
      $r = Invoke-ScriptAnalyzer -Path /scripts/install.ps1
      $r | Format-Table -AutoSize | Out-String | Write-Host
      if ($r | Where-Object { $_.Severity -eq "Error" }) { exit 1 }
      exit 0
    ' >"$WORK/logs/psanalyzer.log" 2>&1; then
    tail -8 "$WORK/logs/psanalyzer.log"
  else
    echo "PSScriptAnalyzer skipped (did not install or run in time); see $WORK/logs/psanalyzer.log"
  fi
fi

say "ALL TESTS PASSED"
