// What the launcher does before the harness starts: it reads the harness version from the installed package instead of
// starting the harness to ask, and it switches Node's compile cache on for the harness. Both were measured on a scripted
// three-request run against a local model endpoint (docs/SPEED.md).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCacheDir, launchEnv, packagedVersionOf, versionOf } from "../lib/dsh.js";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-speed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An installed package: <dir>/pkg/{package.json,lib/bin.js} with <dir>/bin/dsh linked to it, as npm lays it out. */
function install(dir, manifest, script) {
  mkdirSync(join(dir, "pkg", "lib"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "pkg", "lib", "bin.js"), script);
  chmodSync(join(dir, "pkg", "lib", "bin.js"), 0o755);
  symlinkSync(join(dir, "pkg", "lib", "bin.js"), join(dir, "bin", "dsh"));
  return join(dir, "bin", "dsh");
}

const RECORDS = (marker) => `#!/bin/sh\necho started >> "${marker}"\necho 9.9.9\n`;

test("the version comes from the installed package and the harness is not started to ask", (t) => {
  const dir = scratch(t);
  const marker = join(dir, "started");
  const bin = install(dir, { name: "@deepseek-ai/dsh", version: "0.2.2-rc.1" }, RECORDS(marker));
  assert.equal(packagedVersionOf(bin), "0.2.2-rc.1");
  assert.equal(versionOf(bin), "0.2.2-rc.1");
  assert.equal(existsSync(marker), false, "the binary was started although its package states the version");
});

test("a binary that is not the published package is asked, as before", (t) => {
  const dir = scratch(t);
  const marker = join(dir, "started");
  // Another package's manifest sits beside it: its version says nothing about the harness.
  const bin = install(dir, { name: "some-wrapper", version: "5.0.0" }, RECORDS(marker));
  assert.equal(packagedVersionOf(bin), undefined);
  assert.equal(versionOf(bin), "9.9.9");
  assert.equal(readFileSync(marker, "utf8").trim(), "started");
  // No manifest at all, and a manifest whose version is not a version.
  const bare = join(dir, "bare-dsh");
  writeFileSync(bare, "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
  assert.equal(versionOf(bare), "1.2.3");
  const odd = scratch(t);
  assert.equal(packagedVersionOf(install(odd, { name: "@deepseek-ai/dsh", version: "latest" }, RECORDS(join(odd, "m")))), undefined);
  assert.equal(packagedVersionOf(join(dir, "missing")), undefined);
});

test("the harness starts with Node's compile cache in a private folder under the user's cache", (t) => {
  const home = scratch(t);
  const env = launchEnv({ HOME: home, PATH: "/usr/bin" });
  assert.equal(env.NODE_COMPILE_CACHE, join(home, ".cache", "steak-dsh", "compile-cache"));
  assert.equal(existsSync(env.NODE_COMPILE_CACHE), true);
  assert.equal(env.DSH_TELEMETRY_MODE, "DISABLED");
  assert.equal(launchEnv({ HOME: home, XDG_CACHE_HOME: join(home, "xdg") }).NODE_COMPILE_CACHE, join(home, "xdg", "steak-dsh", "compile-cache"));
});

test("the compile cache can be switched off, a caller's own setting is kept, and an unusable folder is not an error", (t) => {
  const home = scratch(t);
  assert.equal("NODE_COMPILE_CACHE" in launchEnv({ HOME: home, STEAK_DSH_COMPILE_CACHE: "0" }), false);
  assert.equal(existsSync(join(home, ".cache")), false, "switched off must create nothing");
  assert.equal(launchEnv({ HOME: home, NODE_COMPILE_CACHE: "/somewhere/else" }).NODE_COMPILE_CACHE, "/somewhere/else");
  writeFileSync(join(home, "file"), "x");
  assert.equal(compileCacheDir({ HOME: join(home, "file") }), undefined);
  assert.equal("NODE_COMPILE_CACHE" in launchEnv({ HOME: join(home, "file") }), false);
});
