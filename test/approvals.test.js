/**
 * The approval policy option, the SDK permission rows, the overlay rewrite before a respawn, the escalation refusal,
 * the crash summary and the Allow-for-this-session key. No model and no harness process are involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOptions } from "../lib/args.js";
import { headlessArgs, overlayFiles, presetTable, sdkPermissionRows } from "../lib/overlay.js";
import { approvalRuleKey, summarizeStderr } from "../lib/tui/session.js";
import { permissionAtom } from "../lib/tui/band.js";
import { apply as applyNever, escalationRefusal } from "../plugins/approval-never.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const opts = (...argv) => parseOptions(argv, { allowTask: false, command: "tui" }).options;

test("--approval-policy: never by default for run, chat and tui; ask on request; anything else is a usage error", () => {
  assert.equal(opts().approvalPolicy, "never");
  assert.equal(opts("--approval-policy", "ask").approvalPolicy, "ask");
  assert.equal(parseOptions(["--approval-policy", "never", "task"]).options.approvalPolicy, "never");
  assert.throws(() => opts("--approval-policy", "on-request"), /--approval-policy must be one of never, ask/);
  assert.throws(() => opts("--approval-policy"), /needs a value/);
});

test("run and chat pass the chosen policy to dsh headless", () => {
  const base = { permission: "workspace-write", addDirs: [], json: false };
  assert.deepEqual(headlessArgs({ ...base, approvalPolicy: "never" }, [], ["t"]), ["headless", "--permission-mode", "workspace-write", "--approval-policy", "never", "--", "t"]);
  assert.ok(headlessArgs({ ...base, approvalPolicy: "ask" }, [], ["t"]).join(" ").includes("--approval-policy ask"));
  assert.ok(headlessArgs(base, [], ["t"]).join(" ").includes("--approval-policy never"), "an options object without the field keeps never");
});

test("tui permission rows: the preset table carries the policy and the chosen preset is the default of a new session", () => {
  assert.deepEqual(presetTable("never"), {
    "read-only": { sandbox: "read-only", approval: "never" },
    "workspace-write": { sandbox: "workspace-write", approval: "never" },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  });
  assert.deepEqual(presetTable("ask"), {
    "read-only": { sandbox: "read-only", approval: "ask" },
    "workspace-write": { sandbox: "workspace-write", approval: "ask" },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  }, "ask is the harness's own table");
  assert.deepEqual(sdkPermissionRows({ permission: "workspace-write", approvalPolicy: "never" }), [
    { id: "approval", config: { policy: "never" } },
    { id: "permission", config: { defaultPreset: "workspace-write", presets: presetTable("never") } },
  ]);
  assert.equal(sdkPermissionRows({ permission: "danger-full-access", approvalPolicy: "ask" })[0].config.policy, "never", "danger-full-access never asks");
  assert.equal(sdkPermissionRows({ permission: "read-only", approvalPolicy: "ask" })[0].config.policy, "ask");
});

test("overlay ensure(): a generated overlay that vanished is written again in a fresh folder; a vanished --patch is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-ensure-"));
  const user = join(dir, "user.yml");
  writeFileSync(user, "[]\n");
  const o = { ...opts("--model", "gw/m", "--patch", user), approvalPolicy: "never" };
  const { files, ensure, cleanup } = overlayFiles(o, root, { sdk: true });
  try {
    assert.equal(files.length, 3, "bundle, generated, user patch");
    const generated = files[1];
    const text = readFileSync(generated, "utf8");
    assert.match(text, /"defaultPreset": "workspace-write"/);
    assert.deepEqual(ensure(), files, "nothing to do while every file is there");
    rmSync(dirname(generated), { recursive: true, force: true });
    const again = ensure();
    assert.notEqual(again[1], generated, "never the old path, which is no longer ours");
    assert.equal(readFileSync(again[1], "utf8"), text);
    rmSync(user);
    assert.throws(() => ensure(), new RegExp(`patch file ${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} no longer exists`));
  } finally {
    const last = files[1];
    cleanup();
    assert.equal(existsSync(last), false, "cleanup removes every generated folder");
    rmSync(dir, { recursive: true, force: true });
  }
  const plain = overlayFiles({ ...opts(), approvalPolicy: "never" }, root);
  assert.equal(plain.files.length, 1, "run and chat without rows still get no temp file");
  plain.cleanup();
});

test("approval-never plugin: an escalation under policy never is refused up front with the preset that allows it", async () => {
  assert.match(escalationRefusal({ sandbox_permissions: "danger-full-access" }, "never", "workspace-write"),
    /refused without asking anyone.*"workspace-write" preset with approval policy "never".*--permission danger-full-access.*--approval-policy ask.*\/permission danger-full-access/s);
  assert.equal(escalationRefusal({ sandbox_permissions: "danger-full-access" }, "ask", "workspace-write"), undefined, "ask: the harness asks");
  assert.equal(escalationRefusal({ sandbox_permissions: "workspace-write" }, "never", "workspace-write"), undefined, "not wider");
  assert.equal(escalationRefusal({ command: "ls" }, "never", "workspace-write"), undefined, "no escalation asked");
  assert.match(escalationRefusal({ sandbox_permissions: "workspace-write" }, "never", "read-only"), /needs the workspace-write preset/);
  let hook;
  const services = { approval: { effectivePolicy: () => "never" }, sandboxPolicy: { resolve: () => ({ mode: "workspace-write" }) } };
  applyNever({ on: (name, fn) => { assert.equal(name, "tools/pre-execute"); hook = fn; }, get: (name) => services[name] });
  const agent = { session: { id: "s" } };
  const passed = { kind: "allow" };
  assert.equal(await hook({ name: "bash", agent, arguments: { command: "ls" } }, async () => passed), passed);
  const denied = await hook({ name: "bash", agent, arguments: { command: "ps", sandbox_permissions: "danger-full-access" } }, async () => passed);
  assert.equal(denied.kind, "deny");
  assert.match(denied.reason, /--permission danger-full-access/);
  services.approval.effectivePolicy = () => "ask";
  assert.equal(await hook({ name: "bash", agent, arguments: { command: "ps", sandbox_permissions: "danger-full-access" } }, async () => passed), passed);
});

test("crash summary: the error line and its top frame, never Node's version banner", () => {
  const node = "file:///x/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4713\n\t\tthrow new Error(`${binName}: failed`);\n\t\t      ^\n\n" +
    "Error: dsh: failed to read overlay /t/overlay.yml: Error: ENOENT: no such file or directory\n" +
    "    at loadOverlayPatches (file:///opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:4713:9)\n" +
    "    at composeProfile (file:///x/lib/profile-boot.js:246:24)\n\nNode.js v22.22.2\n";
  assert.deepEqual(summarizeStderr(node), {
    headline: "Error: dsh: failed to read overlay /t/overlay.yml: Error: ENOENT: no such file or directory",
    frame: "at loadOverlayPatches (@deepseek-ai/dsh-app-boot/lib/index.js:4713:9)",
  });
  const harness = "dsh: fatal uncaught exception: TypeError: cannot read x\n    at step (file:///a/node_modules/pkg/i.js:1:2) {\n  code: 'X'\n}\n";
  assert.equal(summarizeStderr(harness).headline, "dsh: fatal uncaught exception: TypeError: cannot read x");
  assert.equal(summarizeStderr(harness).frame, "at step (pkg/i.js:1:2) {");
  assert.deepEqual(summarizeStderr("fatal: out of memory\n"), { headline: "fatal: out of memory" });
  assert.deepEqual(summarizeStderr("\nNode.js v22.22.2\n"), { headline: undefined });
});

test("Allow-for-this-session key: same session, tool and sandbox mode match whatever the justification says", () => {
  const ask = (reason, extra = {}) => approvalRuleKey({ sessionId: "s", toolName: "bash", reason, ...extra });
  assert.equal(ask("escalate sandbox to danger-full-access: list processes"), ask("escalate sandbox to danger-full-access: read rows"));
  assert.notEqual(ask("escalate sandbox to danger-full-access: x"), ask("escalate sandbox to workspace-write: x"));
  assert.notEqual(ask("escalate sandbox to danger-full-access: x"), ask("escalate sandbox to danger-full-access: x", { toolName: "write" }));
  assert.notEqual(ask("escalate sandbox to danger-full-access: x"), ask("escalate sandbox to danger-full-access: x", { sessionId: "t" }));
  assert.notEqual(ask("open the port"), ask("open another port"), "other approvals match only on the exact reason");
});

test("band: the preset and approval policy are always visible, danger-full-access never asks", () => {
  assert.equal(permissionAtom({ permission: "workspace-write", approvalPolicy: "never" }), "workspace-write · approval never");
  assert.equal(permissionAtom({ permission: "workspace-write", approvalPolicy: "ask" }, "compact"), "ww/ask");
  assert.equal(permissionAtom({ permission: "read-only", approvalPolicy: "ask" }, "tight"), "ro/a");
  assert.equal(permissionAtom({ permission: "danger-full-access", approvalPolicy: "ask" }), "danger-full-access · approval never");
  assert.equal(permissionAtom({}), undefined);
});
