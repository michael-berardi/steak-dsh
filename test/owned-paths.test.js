import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, outside, targetsOf } from "../plugins/owned-paths.js";

const scratch = () => mkdtempSync(join(tmpdir(), "steak-dsh-owned-test-"));

test("outside(): inside, outside, traversal, relative paths and the directory itself", () => {
  const dir = scratch();
  try {
    const owned = join(dir, "owned");
    mkdirSync(owned);
    writeFileSync(join(owned, "a.txt"), "hi");
    assert.equal(outside(join(owned, "a.txt"), dir, [owned]), false, "owned file");
    assert.equal(outside(join(owned, "deep", "new.txt"), dir, [owned]), false, "not-yet-existing file inside");
    assert.equal(outside(owned, dir, [owned]), false, "the directory itself");
    assert.equal(outside(join(dir, "b.txt"), dir, [owned]), true, "sibling file is outside");
    assert.equal(outside(join(owned, "..", "b.txt"), dir, [owned]), true, ".. traversal escapes");
    assert.equal(outside("owned/a.txt", dir, [owned]), false, "relative target resolves against cwd");
    assert.equal(outside("b.txt", dir, [owned]), true, "relative outside target");
    assert.equal(outside(join(dir, "owned-extra", "x"), dir, [owned]), true, "prefix is not containment");
    assert.equal(outside(join(dir, "b.txt"), dir, []), false, "empty list does nothing");
    assert.equal(outside(join(dir, "b.txt"), dir, undefined), false, "missing list does nothing");
    assert.equal(outside("", dir, [owned]), true, "an unusable target cannot be verified");
    assert.equal(outside(join(owned, "a.txt"), dir, [join(owned, "a.txt")]), false, "a single owned file");
    assert.equal(outside(join(owned, "other.txt"), dir, [join(owned, "a.txt")]), true, "other files beside an owned file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outside(): a symlink cannot escape the owned set", () => {
  const dir = scratch();
  try {
    const owned = join(dir, "owned");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(owned);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(owned, "link"));
    symlinkSync(join(elsewhere, "secret.txt"), join(owned, "file-link"));
    assert.equal(outside(join(owned, "link", "x.txt"), dir, [owned]), true, "symlinked directory escapes");
    assert.equal(outside(join(owned, "file-link"), dir, [owned]), true, "symlinked file escapes");
    assert.equal(outside(join(owned, "link"), dir, [owned]), true, "the symlink itself resolves outside");
    symlinkSync(owned, join(dir, "alias"));
    assert.equal(outside(join(dir, "alias", "a.txt"), dir, [owned]), false, "an alias into the owned set is fine");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("targetsOf(): file_path, path and apply_patch headers", () => {
  assert.deepEqual(targetsOf("edit", { file_path: "/a/b" }), ["/a/b"]);
  assert.deepEqual(targetsOf("write", { file_path: "/a/b" }), ["/a/b"]);
  assert.deepEqual(targetsOf("str_replace_editor", { path: "/a/b" }), ["/a/b"]);
  assert.deepEqual(targetsOf("edit", {}), []);
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: sub/b.txt\n+hi\n*** Delete File: c.txt\n*** End Patch";
  assert.deepEqual(targetsOf("apply_patch", { input: patch }), ["a.txt", "sub/b.txt", "c.txt"]);
  assert.deepEqual(targetsOf("apply_patch", { input: "*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved/a.txt\n@@\n x\n*** End Patch" }), ["a.txt", "moved/a.txt"]);
});

const harness = (config, cwd) => {
  const handlers = {};
  apply({ on: (name, fn) => { handlers[name] = fn; }, get: () => ({ get: () => cwd }) }, config);
  return handlers["tools/pre-execute"];
};
const exec = (name, args) => ({ name, arguments: args, agent: { session: {} } });

test("apply(): denies edits outside the owned paths, allows inside, ignores other tools", async () => {
  const dir = scratch();
  try {
    const owned = join(dir, "owned");
    mkdirSync(owned);
    const pre = harness({ paths: [owned] }, dir);
    assert.ok(pre, "listener registered");
    let passed = 0;
    const next = async () => { passed += 1; return { kind: "allow" }; };

    assert.deepEqual(await pre(exec("edit", { file_path: join(owned, "a.txt") }), next), { kind: "allow" });
    assert.equal(passed, 1);

    const denied = await pre(exec("write", { file_path: join(dir, "b.txt") }), next);
    assert.equal(denied.kind, "deny");
    assert.equal(denied.reason, `steak-dsh: ${join(dir, "b.txt")} is outside this task's owned paths (${owned})`);
    assert.equal(passed, 1, "a denied call never reaches next()");

    assert.equal((await pre(exec("read", { file_path: join(dir, "b.txt") }), next)).kind, "allow", "reads are not gated");
    assert.equal((await pre(exec("bash", { command: "ls" }), next)).kind, "allow", "shell is not gated");

    const relative = await pre(exec("edit", { file_path: "b.txt" }), next);
    assert.equal(relative.kind, "deny", "relative paths resolve against the session working directory");
    assert.equal((await pre(exec("edit", { file_path: "owned/a.txt" }), next)).kind, "allow");

    const patch = `*** Begin Patch\n*** Add File: owned/ok.txt\n+hi\n*** Add File: bad.txt\n+no\n*** End Patch`;
    const patchDenied = await pre(exec("apply_patch", { input: patch }), next);
    assert.equal(patchDenied.kind, "deny");
    assert.match(patchDenied.reason, /bad\.txt is outside this task's owned paths/);
    const patchOk = `*** Begin Patch\n*** Add File: owned/ok.txt\n+hi\n*** End Patch`;
    assert.equal((await pre(exec("apply_patch", { input: patchOk }), next)).kind, "allow");
    assert.equal((await pre(exec("apply_patch", { input: "*** Begin Patch\n*** End Patch" }), next)).kind, "deny", "an unverifiable patch is refused");
    assert.equal((await pre(exec("edit", {}), next)).kind, "deny", "a pathless edit is refused");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("apply(): empty or missing paths registers nothing", () => {
  const dir = scratch();
  try {
    assert.equal(harness({}, dir), undefined);
    assert.equal(harness({ paths: [] }, dir), undefined);
    assert.equal(harness({ paths: ["", "  "] }, dir), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
