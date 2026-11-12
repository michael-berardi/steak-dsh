import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));
const sh = read("scripts/install.sh");
const ps1 = read("scripts/install.ps1");
const build = read("scripts/build-release.sh");

// ---- static guards: the Windows-only code cannot run here, so the bad patterns must never come back

test("install.ps1 never writes a shim in ASCII and never moves a folder out of %TEMP%", () => {
  const code = ps1.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /-Encoding\s+ascii/i, "Set-Content -Encoding Ascii turns a non-ASCII profile path into '?'");
  assert.match(code, /OEMCodePage/, ".cmd shims are written in the OEM code page");
  assert.match(code, /%~dp0/, ".cmd shims use shim-relative paths inside the tool home");
  assert.doesNotMatch(code, /Move-Item\s+\$src\b/, "the release must be unpacked into a staging folder under the tool home");
  assert.match(code, /\$relTmp\s*=\s*"\$rel\.tmp"/);
});

test("install.ps1 normalises HOME and BIN_DIR, opts into TLS 1.2, and keeps the session clean", () => {
  assert.match(ps1, /\$homeDir\s*=\s*\$ExecutionContext\.SessionState\.Path\.GetUnresolvedProviderPathFromPSPath\(\$homeDir\)/);
  assert.match(ps1, /\$binDir\s*=\s*\$ExecutionContext\.SessionState\.Path\.GetUnresolvedProviderPathFromPSPath\(\$binDir\)/);
  assert.doesNotMatch(ps1, /FullName\s+-ne\s+\$rel/, "cleanup must not compare full paths");
  assert.match(ps1, /SecurityProtocolType\]::Tls12/);
  assert.match(ps1, /\$ProgressPreference\s*=\s*'SilentlyContinue'/);
  const code = ps1.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /^\$ErrorActionPreference/m, "no top-level preference change leaks into the user's session");
  assert.doesNotMatch(code, /^\s*exit\b/m, "exit would close the user's shell");
  assert.match(ps1, /Install-SteakDsh\s*$/);
});

test("install.ps1 falls back to the npm on PATH and finds a broken junction", () => {
  assert.match(ps1, /Get-Command \$\(if \(\$onWindows\) \{ 'npm\.cmd' \}/);
  assert.match(ps1, /Get-Item -LiteralPath \$current -Force -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(ps1, /if \(Test-Path \$current\)/);
});

test("both installers mark their shims and never overwrite a file they did not write", () => {
  for (const [name, text] of [["install.sh", sh], ["install.ps1", ps1]]) {
    assert.match(text, /steak-dsh installer shim/, name);
  }
  assert.match(ps1, /function Write-Shim/);
  assert.doesNotMatch(ps1, /Set-Content\s+-Path\s+\$shim/);
  assert.match(sh, /shim_ours "\$BIN_DIR\/dsh"/);
  assert.match(sh, /shim_ours "\$LAUNCHER" 'STEAK_DSH_DSH_BIN'/);
  assert.doesNotMatch(sh, /"\$found" = "\$BIN_DIR\/dsh"/, "a marked shim is ours wherever it sits on PATH");
});

test("install.sh replaces a private Node that fails node_ok", () => {
  assert.doesNotMatch(sh, /if \[ ! -x "\$HOME_DIR\/node\/bin\/node" \]; then/);
});

test("build-release.sh refuses dangerous output folders and compresses with gzip -n", () => {
  assert.match(build, /gzip -n/);
  assert.match(build, /OUT="\$\{1-dist\/release\}"/);
  const repoRoot = spawnSync("sh", ["scripts/build-release.sh", "."], { cwd: root, encoding: "utf8" });
  assert.notEqual(repoRoot.status, 0);
  assert.match(repoRoot.stderr, /refusing/);
  for (const bad of ["", "/", ".", "..", "scripts/.."]) {
    const r = spawnSync("sh", ["scripts/build-release.sh", bad], { cwd: root, encoding: "utf8" });
    assert.notEqual(r.status, 0, `'${bad}' must be refused`);
    assert.match(r.stderr, /refusing/, bad);
  }
  assert.ok(existsSync(join(root, "package.json")), "the repository is still there");
});

// ---- behaviour of install.sh against a local release folder (file:// base), with a stand-in dsh

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "steak-dsh-itest-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const rel = join(base, "release");
  mkdirSync(rel);
  const files = ["package.json", ...pkg.files];
  const tar = spawnSync("tar", ["-czf", join(rel, "steak-dsh.tar.gz"), "-C", root, ...files], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  const sum = spawnSync("sh", ["-c", `cd "${rel}" && (sha256sum steak-dsh.tar.gz 2>/dev/null || shasum -a 256 steak-dsh.tar.gz) > SHA256SUMS`]);
  assert.equal(sum.status, 0);
  const home = join(base, "home");
  const priv = join(home, "dsh/node_modules/.bin");
  mkdirSync(priv, { recursive: true });
  const fake = (exit) => `#!/bin/sh\ncase "$1" in --version) echo 0.2.2-rc.1 ;; plugin) exit ${exit} ;; *) exit 0 ;; esac\n`;
  writeFileSync(join(priv, "dsh"), fake(0));
  chmodSync(join(priv, "dsh"), 0o755);
  const bin = join(base, "bin");
  mkdirSync(bin);
  const run = (extra = {}) => spawnSync("sh", [join(root, "scripts/install.sh")], {
    encoding: "utf8",
    env: {
      HOME: join(base, "userhome"), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: base,
      STEAK_DSH_HOME: home, STEAK_DSH_BIN_DIR: bin, STEAK_DSH_RELEASE_BASE: `file://${rel}`, ...extra,
    },
  });
  return { base, home, priv, bin, run, fake };
}

test("install.sh keeps a dsh the user put in BIN_DIR when BIN_DIR is not on PATH", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bin, "dsh"), "#!/bin/sh\necho mine\n");
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(f.bin, "dsh"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.match(r.stdout, /dsh is not a file this installer wrote; leaving it alone/);
  assert.ok(existsSync(join(f.bin, "steak-dsh")));
});

test("install.sh writes marked shims, and a re-run replaces them (also a 0.2.0 launcher without a marker)", (t) => {
  const f = fixture(t);
  let r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(readFileSync(join(f.bin, "dsh"), "utf8"), /steak-dsh installer shim/);
  assert.match(readFileSync(join(f.bin, "steak-dsh"), "utf8"), /steak-dsh installer shim/);
  writeFileSync(join(f.bin, "steak-dsh"), '#!/bin/sh\nSTEAK_DSH_DSH_BIN="old"\nexport STEAK_DSH_DSH_BIN\nexec old\n');
  r = f.run({ PATH: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /leaving it alone/);
  assert.doesNotMatch(r.stdout, /already on PATH/, "our own marked dsh shim is not the user's dsh");
  assert.match(readFileSync(join(f.bin, "steak-dsh"), "utf8"), /steak-dsh installer shim/);
});

test("install.sh does not leave a user's own steak-dsh command replaced", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bin, "steak-dsh"), "#!/bin/sh\necho mine\n");
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(f.bin, "steak-dsh"), "utf8"), "#!/bin/sh\necho mine\n");
  assert.match(r.stdout, /steak-dsh is not a file this installer wrote/);
});

test("install.sh does not claim it added Steak DSH to dsh when plugin add failed", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.priv, "dsh"), f.fake(1));
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /warning: could not add the bundle/);
  assert.doesNotMatch(r.stdout, /added Steak DSH to it|installed DeepSeek Harness and Steak DSH/);
  assert.match(r.stdout, /not in the dsh headless profile yet/);
});
