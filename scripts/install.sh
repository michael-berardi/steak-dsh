#!/bin/sh
# Steak DSH installer for macOS and Linux:  curl -fsSL https://github.com/michael-berardi/steak-dsh/releases/latest/download/install.sh | sh
# One step, whole bundle: checks the release SHA-256, installs Steak DSH, brings Node 22+ when missing (official build,
# kept in Steak DSH's own folder), installs DeepSeek Harness (dsh) when missing, adds the bundle to the dsh "headless"
# profile, and puts `steak-dsh` on your PATH. Nothing global, no sudo, no shell profile edits. Re-running upgrades.
# Layout: $STEAK_DSH_HOME/app/current -> release-<version>/, plus node/, dsh/ and tools/ only when they were fetched.
# Environment: STEAK_DSH_HOME (default ~/.steak-dsh), STEAK_DSH_BIN_DIR (default ~/.local/bin),
# STEAK_DSH_VERSION (pin a release, e.g. 0.1.2), STEAK_DSH_RELEASE_BASE (override the download base URL, used by tests),
# STEAK_DSH_DSH_VERSION (the dsh version to install when missing, default 0.2.2-rc.1).
set -eu

REPO="michael-berardi/steak-dsh"
NODE_MIN_MAJOR=22
DSH_MIN="0.2.2-rc.1"
DSH_VERSION="${STEAK_DSH_DSH_VERSION:-0.2.2-rc.1}"
HOME_DIR="${STEAK_DSH_HOME:-$HOME/.steak-dsh}"
case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
APP="$HOME_DIR/app"
BIN_DIR="${STEAK_DSH_BIN_DIR:-$HOME/.local/bin}"
case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd)/$BIN_DIR" ;; esac
if [ -n "${STEAK_DSH_RELEASE_BASE:-}" ]; then BASE="$STEAK_DSH_RELEASE_BASE"
elif [ -n "${STEAK_DSH_VERSION:-}" ]; then BASE="https://github.com/$REPO/releases/download/v${STEAK_DSH_VERSION#v}"
else BASE="https://github.com/$REPO/releases/latest/download"; fi

say() { printf '%s\n' "$*"; }
die() { printf 'steak-dsh install: %s\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1" || die "download failed: $1"; }
else die "needs curl or wget; install one with your package manager (for example: apt-get install curl)"; fi
command -v tar >/dev/null 2>&1 || die "needs tar; install it with your package manager (for example: apt-get install tar)"

if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "needs sha256sum or shasum; install coreutils with your package manager"; fi

main() {
TMP=$(mktemp -d "${TMPDIR:-/tmp}/steak-dsh-install.XXXXXX") || die "cannot create a temporary folder"
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# expect <file> <name> <sums-file>: the file's SHA-256 must equal the line for <name> in the sums file.
expect() {
  want=$(awk -v n="$2" '{ f=$2; sub(/^\*/, "", f); if (f == n) print $1 }' "$3")
  [ -n "$want" ] || die "no checksum for $2 in $(basename "$3")"
  [ "$(sha256 "$1")" = "$want" ] || die "checksum mismatch for $2; nothing was installed"
}

say "Downloading Steak DSH..."
fetch "$BASE/steak-dsh.tar.gz" "$TMP/steak-dsh.tar.gz"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"
expect "$TMP/steak-dsh.tar.gz" steak-dsh.tar.gz "$TMP/SHA256SUMS"
mkdir "$TMP/src"
tar -xzf "$TMP/steak-dsh.tar.gz" -C "$TMP/src" || die "cannot unpack the download"
[ -f "$TMP/src/package.json" ] && [ -f "$TMP/src/cordis.patch.yml" ] && [ -f "$TMP/src/bin/steak-dsh" ] || die "the download is not a Steak DSH release"
VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/src/package.json" | head -n 1)
[ -n "$VERSION" ] || die "cannot read the release version"

node_ok() { # node_ok <node-binary>: major version >= 22
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}
  [ "$major" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

# Node: the one on PATH when it is new enough, else the official build, kept inside Steak DSH's own folder.
NODE_BIN=""
NODE_PRIVATE=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN=$(command -v node)
  # A private Node that happens to be on PATH stays private, so the shims keep working without it.
  [ "$NODE_BIN" != "$HOME_DIR/node/bin/node" ] || NODE_PRIVATE=1
elif [ -x "$HOME_DIR/node/bin/node" ] && node_ok "$HOME_DIR/node/bin/node"; then
  NODE_BIN="$HOME_DIR/node/bin/node"; NODE_PRIVATE=1
else
  ls /lib/ld-musl-* >/dev/null 2>&1 && die "this system uses musl (Alpine): install Node 22+ with its package manager (apk add nodejs npm), then run this again"
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported system $(uname -s); on Windows use install.ps1" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  say "Node $NODE_MIN_MAJOR or newer not found; fetching the official Node 22 LTS for $os-$arch..."
  nbase="https://nodejs.org/dist/latest-v22.x"
  fetch "$nbase/SHASUMS256.txt" "$TMP/NODESUMS"
  nname=$(awk -v s="-$os-$arch.tar.gz" 'index($2, s) { print $2 }' "$TMP/NODESUMS" | head -n 1)
  [ -n "$nname" ] || die "no official Node build for $os-$arch"
  fetch "$nbase/$nname" "$TMP/$nname"
  expect "$TMP/$nname" "$nname" "$TMP/NODESUMS"
  mkdir -p "$HOME_DIR"
  if [ ! -x "$HOME_DIR/node/bin/node" ]; then
    rm -rf "$HOME_DIR/node.tmp"; mkdir "$HOME_DIR/node.tmp"
    tar -xzf "$TMP/$nname" -C "$HOME_DIR/node.tmp" --strip-components=1 || die "cannot unpack Node"
    rm -rf "$HOME_DIR/node"; mv "$HOME_DIR/node.tmp" "$HOME_DIR/node"
  fi
  NODE_BIN="$HOME_DIR/node/bin/node"; NODE_PRIVATE=1
  node_ok "$NODE_BIN" || die "the downloaded Node does not run on this machine"
fi
PATH="$(dirname "$NODE_BIN"):$PATH"; export PATH
NPM="$(dirname "$NODE_BIN")/npm"; [ -x "$NPM" ] || NPM=npm
command -v "$NPM" >/dev/null 2>&1 || die "npm was not found next to Node ($NODE_BIN); install npm, then run this again"

# ver_ge <version> <min>: semver >= with prerelease rules, checked with the Node we just resolved.
cat > "$TMP/ver_ge.js" <<'VERJS'
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
VERJS
ver_ge() { "$NODE_BIN" "$TMP/ver_ge.js" "$1" "$2" >/dev/null 2>&1; }

# dsh: a working one on PATH when it is new enough, else a private npm install in Steak DSH's own folder.
HAD_DSH=""
DSH_BIN=""
if command -v dsh >/dev/null 2>&1; then
  found=$(command -v dsh)
  if [ "$found" = "$BIN_DIR/dsh" ] && grep -q 'steak-dsh installer shim' "$found" 2>/dev/null; then
    : # the shim an earlier run of this installer wrote: not the user's dsh, so the private copy is used
  else
    HAD_DSH=$found
    dshv=$("$HAD_DSH" --version 2>/dev/null </dev/null | head -n 1) || dshv=""
    if [ -n "$dshv" ] && ver_ge "$dshv" "$DSH_MIN"; then
      DSH_BIN=$HAD_DSH
      say "Using the dsh already on PATH: $DSH_BIN ($dshv)."
    else
      say "The dsh on PATH ($HAD_DSH) does not run or is older than $DSH_MIN; installing a private copy."
    fi
  fi
fi
PRIV_DSH="$HOME_DIR/dsh/node_modules/.bin/dsh"
if [ -z "$DSH_BIN" ] && [ -x "$PRIV_DSH" ]; then
  pv=$("$PRIV_DSH" --version 2>/dev/null </dev/null | head -n 1) || pv=""
  if [ -n "$pv" ] && ver_ge "$pv" "$DSH_MIN"; then
    DSH_BIN=$PRIV_DSH
    say "Using the dsh installed earlier: $DSH_BIN ($pv)."
  fi
fi
if [ -z "$DSH_BIN" ]; then
  say "Installing DeepSeek Harness (dsh $DSH_VERSION) with npm; about 650 packages, this can take a few minutes..."
  mkdir -p "$HOME_DIR"
  rm -rf "$HOME_DIR/dsh.tmp"
  ( npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      "$NPM" install --prefix "$HOME_DIR/dsh.tmp" "@deepseek-ai/dsh@$DSH_VERSION" \
      --no-audit --no-fund --loglevel=error </dev/null ) \
    || { rm -rf "$HOME_DIR/dsh.tmp"; die "npm could not install @deepseek-ai/dsh@$DSH_VERSION (network or registry problem); nothing was changed"; }
  [ -x "$HOME_DIR/dsh.tmp/node_modules/.bin/dsh" ] || { rm -rf "$HOME_DIR/dsh.tmp"; die "the dsh package did not install a dsh command; nothing was changed"; }
  rm -rf "$HOME_DIR/dsh.old"
  [ ! -d "$HOME_DIR/dsh" ] || mv "$HOME_DIR/dsh" "$HOME_DIR/dsh.old"
  mv "$HOME_DIR/dsh.tmp" "$HOME_DIR/dsh"
  rm -rf "$HOME_DIR/dsh.old"
  DSH_BIN=$PRIV_DSH
  dv=$("$DSH_BIN" --version 2>/dev/null </dev/null | head -n 1) || dv=""
  { [ -n "$dv" ] && ver_ge "$dv" "$DSH_MIN"; } || die "the installed dsh does not run (version: '${dv:-unreadable}'); it needs Node $NODE_MIN_MAJOR+; nothing else was changed"
fi

mkdir -p "$APP" "$BIN_DIR"
chmod 700 "$HOME_DIR" 2>/dev/null || true

# Steak DSH itself: stage, check it starts, then move into place and swap the current link.
REL="$APP/release-$VERSION"
if [ ! -d "$REL" ]; then
  say "Installing Steak DSH $VERSION..."
  rm -rf "$REL.tmp"; mv "$TMP/src" "$REL.tmp"
  got=$("$NODE_BIN" "$REL.tmp/bin/steak-dsh" --version 2>&1 </dev/null) || { rm -rf "$REL.tmp"; die "the new copy does not start: $got"; }
  case "$got" in "$VERSION"*) ;; *) rm -rf "$REL.tmp"; die "the new copy reports '$got', not $VERSION; nothing was changed" ;; esac
  mv "$REL.tmp" "$REL"
else
  say "Steak DSH $VERSION is already unpacked; relinking."
fi
# Atomic link swap: rename a fresh link over the old one (GNU mv -T, BSD/macOS mv -h; never into the directory it points at).
swap_link() { # swap_link <target> <link>
  ln -s "$1" "$2.tmp.$$"
  if mv -fT "$2.tmp.$$" "$2" 2>/dev/null || mv -fh "$2.tmp.$$" "$2" 2>/dev/null; then return 0; fi
  if rm -f "$2" && mv "$2.tmp.$$" "$2"; then return 0; fi
  rm -f "$2.tmp.$$"; die "cannot update the link $2"
}
swap_link "$REL" "$APP/current"
for d in "$APP"/release-*; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$d" != "$REL" ] && rm -rf "$d"
done

# The private Node, when we fetched one, goes on PATH inside the shims only.
NODE_PATH_LINE=""
[ -z "$NODE_PRIVATE" ] || NODE_PATH_LINE="PATH=\"$(dirname "$NODE_BIN"):\$PATH\"; export PATH"

# A dsh shim only when no dsh existed on PATH; an existing dsh is never shadowed.
if [ -z "$HAD_DSH" ]; then
  cat > "$BIN_DIR/dsh.tmp.$$" <<DSHWRAP
#!/bin/sh
# steak-dsh installer shim: runs the dsh that Steak DSH installed. Delete this file to use another dsh.
$NODE_PATH_LINE
exec "$DSH_BIN" "\$@"
DSHWRAP
  chmod 755 "$BIN_DIR/dsh.tmp.$$"; mv -f "$BIN_DIR/dsh.tmp.$$" "$BIN_DIR/dsh"
fi

# Add the bundle to the dsh headless profile. dsh needs pnpm for this; bring it privately when missing.
say "Adding Steak DSH to the dsh headless profile..."
PNPM_DIR=""
if command -v pnpm >/dev/null 2>&1; then
  :
elif command -v corepack >/dev/null 2>&1 && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --version >/dev/null 2>&1 </dev/null; then
  mkdir -p "$TMP/pnpm-bin"
  printf '#!/bin/sh\nexport COREPACK_ENABLE_DOWNLOAD_PROMPT=0\nexec corepack pnpm "$@"\n' > "$TMP/pnpm-bin/pnpm"
  chmod 755 "$TMP/pnpm-bin/pnpm"
  PNPM_DIR="$TMP/pnpm-bin"
else
  say "pnpm not found; installing it privately into $HOME_DIR/tools for this step..."
  ( npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      "$NPM" install --prefix "$HOME_DIR/tools" pnpm --no-audit --no-fund --loglevel=error </dev/null ) \
    || say "steak-dsh install: warning: npm could not install pnpm (network or registry problem)"
  PNPM_DIR="$HOME_DIR/tools/node_modules/.bin"
fi
if PATH="${PNPM_DIR:+$PNPM_DIR:}$PATH" "$DSH_BIN" plugin --profile headless add "$APP/current" </dev/null; then
  say "Steak DSH added to the dsh headless profile."
else
  say "steak-dsh install: warning: could not add the bundle to the dsh headless profile; the steak-dsh launcher works without it. Try again later with: steak-dsh install"
fi

# `steak-dsh` on PATH: points at the dsh we resolved and, when fetched, at the private Node.
cat > "$BIN_DIR/steak-dsh.tmp.$$" <<WRAP
#!/bin/sh
STEAK_DSH_DSH_BIN="\${STEAK_DSH_DSH_BIN:-$DSH_BIN}"
export STEAK_DSH_DSH_BIN
$NODE_PATH_LINE
exec "$APP/current/bin/steak-dsh" "\$@"
WRAP
chmod 755 "$BIN_DIR/steak-dsh.tmp.$$"; mv -f "$BIN_DIR/steak-dsh.tmp.$$" "$BIN_DIR/steak-dsh"

say "Checking the installation (steak-dsh doctor)..."
"$BIN_DIR/steak-dsh" doctor </dev/null || die "steak-dsh doctor failed; see its output above"

if [ "$DSH_BIN" = "$HAD_DSH" ] && [ -n "$HAD_DSH" ]; then
  say "dsh was already installed: added Steak DSH to it"
else
  say "installed DeepSeek Harness and Steak DSH"
fi
say "Steak DSH $VERSION installed ($BIN_DIR/steak-dsh)."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
say "Next: steak-dsh run \"fix the failing test in src/parser\""
}

main "$@"
