#!/bin/sh
# Builds the download assets for the current commit into <out> (default dist/release):
#   steak-dsh.tar.gz   the package's shipped files (package.json "files" plus package.json itself)
#   install.sh, install.ps1   the one-step installers
#   SHA256SUMS    checksums of the three files above
# Usage: scripts/build-release.sh [out-dir]   (run from a clean checkout of the release tag)
set -eu
cd "$(dirname "$0")/.."
OUT="${1-dist/release}"
ROOT=$(pwd -P)
# Refuse an output folder that would make `rm -rf` destroy more than a build: empty, `.`, `/`, the repository
# root, or any folder that contains it.
case "$OUT" in ""|.|./|/|..|../) echo "build-release: refusing to use '$OUT' as the output folder" >&2; exit 1 ;; esac
if [ -d "$OUT" ]; then
  out_abs=$(cd "$OUT" && pwd -P)
  case "$ROOT/" in "$out_abs"/*) echo "build-release: refusing to use '$OUT' (the repository root or a folder above it) as the output folder" >&2; exit 1 ;; esac
  [ "$out_abs" != "/" ] || { echo "build-release: refusing to use '/' as the output folder" >&2; exit 1; }
fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "build-release: the working tree has changes; build from a clean checkout" >&2; exit 1; }
commit=$(git rev-parse HEAD)
rm -rf "$OUT"; mkdir -p "$OUT"
stage=$(mktemp -d "${TMPDIR:-/tmp}/steak-dsh-build.XXXXXX"); trap 'rm -rf "$stage"' EXIT
# Exactly what npm would ship: the "files" list in package.json, plus package.json itself. The list is read from
# package.json so a newly shipped file (0.2.0 added long.patch.yml) can never be left out of the archive.
command -v node >/dev/null 2>&1 || { echo "build-release: needs node to read the files list from package.json" >&2; exit 1; }
node -e 'const f = require("./package.json").files; if (!Array.isArray(f) || f.length === 0) process.exit(1); process.stdout.write(f.join("\n") + "\n")' > "$stage.files" \
  || { echo "build-release: package.json has no files list" >&2; exit 1; }
set -- package.json
while IFS= read -r entry; do set -- "$@" "$entry"; done < "$stage.files"
rm -f "$stage.files"
git archive --format=tar HEAD -- "$@" | tar -x -C "$stage" || { echo "build-release: a path in the package.json files list is not committed" >&2; exit 1; }
for entry in "$@"; do
  [ -e "$stage/$entry" ] || { echo "build-release: $entry is in the package.json files list but missing from HEAD" >&2; exit 1; }
done
# Deterministic: sorted names, fixed owner and times.
( cd "$stage" && find . -mindepth 1 | LC_ALL=C sort | sed 's|^\./||' > "$stage.list" )
if tar --version 2>/dev/null | grep -qi gnu; then
  tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime=@0 --no-recursion -czf "$OUT/steak-dsh.tar.gz" -T "$stage.list"
else
  # bsdtar cannot leave the time out of the gzip header itself, so compress with `gzip -n`.
  # A temp tar first, so a tar failure is not hidden by a pipe.
  COPYFILE_DISABLE=1 tar -C "$stage" --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-recursion -cf "$stage.tar" -T "$stage.list" \
    || { echo "build-release: tar failed" >&2; exit 1; }
  gzip -n < "$stage.tar" > "$OUT/steak-dsh.tar.gz" || { echo "build-release: gzip failed" >&2; exit 1; }
  rm -f "$stage.tar"
fi
rm -f "$stage.list"
cp scripts/install.sh scripts/install.ps1 "$OUT/"
( cd "$OUT" && if command -v sha256sum >/dev/null 2>&1; then sha256sum steak-dsh.tar.gz install.sh install.ps1; else shasum -a 256 steak-dsh.tar.gz install.sh install.ps1; fi > SHA256SUMS )
echo "built $OUT for $commit"; ls -l "$OUT"
