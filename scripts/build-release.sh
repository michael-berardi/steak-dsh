#!/bin/sh
# Builds the download assets for the current commit into <out> (default dist/release):
#   steak-dsh.tar.gz   the package's shipped files (package.json "files" plus package.json itself)
#   install.sh, install.ps1   the one-step installers
#   SHA256SUMS    checksums of the three files above
# Usage: scripts/build-release.sh [out-dir]   (run from a clean checkout of the release tag)
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-dist/release}"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "build-release: the working tree has changes; build from a clean checkout" >&2; exit 1; }
commit=$(git rev-parse HEAD)
rm -rf "$OUT"; mkdir -p "$OUT"
stage=$(mktemp -d "${TMPDIR:-/tmp}/steak-dsh-build.XXXXXX"); trap 'rm -rf "$stage"' EXIT
# Exactly what npm would ship: the "files" list in package.json, plus package.json itself.
git archive --format=tar HEAD -- package.json plugins bin lib cordis.patch.yml README.md CHANGELOG.md LICENSE | tar -x -C "$stage"
[ -f "$stage/package.json" ] && [ -f "$stage/cordis.patch.yml" ] || { echo "build-release: the shipped files are missing from HEAD" >&2; exit 1; }
# Deterministic: sorted names, fixed owner and times.
( cd "$stage" && find . -mindepth 1 | LC_ALL=C sort | sed 's|^\./||' > "$stage.list" )
if tar --version 2>/dev/null | grep -qi gnu; then
  tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime=@0 --no-recursion -czf "$OUT/steak-dsh.tar.gz" -T "$stage.list"
else
  COPYFILE_DISABLE=1 tar -C "$stage" --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-recursion -czf "$OUT/steak-dsh.tar.gz" -T "$stage.list"
fi
rm -f "$stage.list"
cp scripts/install.sh scripts/install.ps1 "$OUT/"
( cd "$OUT" && if command -v sha256sum >/dev/null 2>&1; then sha256sum steak-dsh.tar.gz install.sh install.ps1; else shasum -a 256 steak-dsh.tar.gz install.sh install.ps1; fi > SHA256SUMS )
echo "built $OUT for $commit"; ls -l "$OUT"
