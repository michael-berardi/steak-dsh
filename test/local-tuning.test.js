import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { tuningLine, resolveUio } = await import(join(root, "lib", "local.js"));

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-tuning-"));
  const agent = join(dir, "agent");
  const profiles = join(agent, "local", "profiles");
  mkdirSync(profiles, { recursive: true });
  const uio = join(dir, "uio");
  writeFileSync(uio, `#!${process.execPath}\nif (process.argv[2] === "--version") { console.log("uio 1.2.3"); process.exit(0); }\nprocess.exit(1);\n`);
  chmodSync(uio, 0o755);
  const env = { PI_CODING_AGENT_DIR: agent, PATH: "", HOME: join(dir, "home") };
  return { dir, profiles, uio, env };
}

test("local tuning row: uio missing, no profiles", () => {
  const s = scratch();
  assert.equal(resolveUio(s.env), undefined);
  assert.equal(tuningLine(s.env), "local tuning: uio not installed (optional: steak-pi local tune); no local profiles");
});

test("local tuning row: uio version, and per profile a tune record or none", () => {
  const s = scratch();
  const work = join(s.dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "best-config.json"), "{}");
  writeFileSync(join(s.profiles, "a.json"), JSON.stringify({ uioLastTune: { at: "2026-11-21T10:00:00.000Z", workdir: work, decodeTokS: 24.5 } }));
  writeFileSync(join(s.profiles, "b.json"), "{}");
  const env = { ...s.env, STEAK_PI_UIO: s.uio };
  assert.equal(tuningLine(env), `local tuning: uio 1.2.3 at ${s.uio}; a: tuned 2026-11-21 (24.5 tok/s decode); b: no uio tune record`);
});

test("local tuning row: omits the tok/s when decodeTokS is absent, null or not a number", () => {
  const s = scratch();
  const work = join(s.dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "best-config.json"), "{}");
  const at = "2026-11-21T10:00:00.000Z";
  writeFileSync(join(s.profiles, "a.json"), JSON.stringify({ uioLastTune: { at, workdir: work } }));
  writeFileSync(join(s.profiles, "b.json"), JSON.stringify({ uioLastTune: { at, workdir: work, decodeTokS: null } }));
  writeFileSync(join(s.profiles, "c.json"), JSON.stringify({ uioLastTune: { at, workdir: work, decodeTokS: "fast" } }));
  const env = { ...s.env, STEAK_PI_UIO: s.uio };
  assert.equal(tuningLine(env), `local tuning: uio 1.2.3 at ${s.uio}; a: tuned 2026-11-21; b: tuned 2026-11-21; c: tuned 2026-11-21`);
});

test("local tuning row: finds uio on PATH, and says when the recorded workdir is gone", () => {
  const s = scratch();
  writeFileSync(join(s.profiles, "a.json"), JSON.stringify({ uioLastTune: { at: "2026-11-21T10:00:00.000Z", workdir: join(s.dir, "gone"), decodeTokS: 20 } }));
  const env = { ...s.env, PATH: s.dir };
  assert.match(tuningLine(env), /uio 1\.2\.3 at .*; a: tuned 2026-11-21 \(20 tok\/s decode\), record missing$/);
});

test("steak-dsh doctor prints the local tuning row", () => {
  const s = scratch();
  const r = spawnSync(process.execPath, [join(root, "bin", "steak-dsh"), "doctor"], { encoding: "utf8", env: { ...process.env, ...s.env, PATH: process.env.PATH } });
  assert.match(r.stdout, /^local tuning: /m);
});
