/**
 * The generated overlay: one temp file holding the rows the flags ask for.
 *
 * YAML emitter: JSON flow syntax is valid YAML (double-quoted strings, escaped control characters),
 * so JSON.stringify is a safe emitter: user text is never interpolated raw into the document.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function emitYaml(document) {
  return JSON.stringify(document, null, 2) + "\n";
}

/** The rows generated from the parsed options, in application order. */
/**
 * Compat switches dsh refuses on a declared gateway route (it keeps them for its own catalog routes) and
 * aborts the run over. A route copied from another tool's model table often carries one, so they are left
 * out with a note instead of failing the run.
 */
export const WITHHELD_COMPAT = new Set([
  "sendSessionAffinityHeaders", "sessionAffinityFormat", "openRouterRouting", "vercelGatewayRouting", "zaiToolStream",
  "supportsOpenAIGrammarTools", "supportsMidConvoSystemMessages", "supportsMidConvoToolAdditions",
  "supportsMidConvoToolChanges", "supportsMidConvoEffort", "supportsAdditionalTools", "supportsToolSearch",
  "supportsExplicitPromptCacheMode", "allowedFallbackModels",
]);

export function splitCompat(compat) {
  const kept = {};
  const dropped = [];
  for (const [key, value] of Object.entries(compat ?? {})) {
    if (WITHHELD_COMPAT.has(key) || value === null || value === undefined) dropped.push(key);
    else kept[key] = value;
  }
  return { kept, dropped };
}

/**
 * The long-work profile (`--long`) is a shipped patch file applied right after the bundle patch: the rows a
 * multi-step or delegating task needs and a one-shot task does not. One file, so a direct `dsh --patch` run and
 * the launcher use the same rows.
 */
export const LONG_PROFILE_PATCH = "long.patch.yml";

export function buildRows(o, root, onNote) {
  const rows = [];
  if (o.baseUrl !== undefined) {
    const model = { id: o.model };
    if (o.contextWindow !== undefined) model.contextWindow = o.contextWindow;
    // A declared gateway model has no catalog entry, so the harness would refuse any effort it was not told about.
    if (o.effort !== undefined && o.effort !== "off") model.reasoningEfforts = { off: null, [o.effort]: o.effortWire ?? o.effort };
    const route = { apiKeyEnv: o.keyEnv, api: o.api, baseURL: o.baseUrl, models: [model] };
    if (o.compat !== undefined) {
      const { kept, dropped } = splitCompat(o.compat);
      if (Object.keys(kept).length > 0) route.compat = kept;
      if (dropped.length > 0 && onNote) onNote(`compat ${dropped.join(", ")} cannot be set on a declared dsh route and was left out`);
    }
    rows.push({ id: "llm-pi-ai", config: { providers: { [o.provider]: route } } });
  }
  if (o.model !== undefined) {
    const config = { provider: o.provider, model: o.model };
    if (o.effort !== undefined) config.reasoningEffort = o.effort;
    rows.push({ id: "agent-default-model", config });
  }
  if (o.noShell) {
    for (const id of ["tool-bash", "tool-pwsh", "tool-jobs"]) rows.push({ id, disabled: true });
  }
  if (o.ownedPaths.length > 0) {
    rows.push({
      insert: [{
        id: "steak-owned-paths",
        name: pathToFileURL(join(root, "plugins", "owned-paths.js")).href,
        config: { paths: o.ownedPaths },
      }],
    });
  }
  if (o.verify !== undefined) rows.push({ id: "steak-verify-after-edit", config: { command: o.verify } });
  return rows;
}

/**
 * The permission rows for the SDK profile (`steak-dsh tui`). The SDK wire has no approval-policy switch: a session's
 * policy comes from its permission preset, and a new session is pinned to the default preset when it is created.
 * So the preset table is rewritten to carry the chosen policy, and the chosen preset becomes the default:
 *   never: every preset has approval `never` (nothing is asked; an escalation is refused), as `run` and `chat` do
 *          with `--approval-policy never`;
 *   ask:   the harness's own table (read-only and workspace-write ask, danger-full-access never).
 * `/permission <preset>` after the handshake then applies the same pair to a resumed session.
 */
export function presetTable(approvalPolicy) {
  const ask = approvalPolicy === "ask";
  return {
    "read-only": { sandbox: "read-only", approval: ask ? "ask" : "never" },
    "workspace-write": { sandbox: "workspace-write", approval: ask ? "ask" : "never" },
    "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
  };
}

export function sdkPermissionRows(o) {
  const presets = presetTable(o.approvalPolicy);
  const preset = o.permission ?? "danger-full-access";
  return [
    { id: "approval", config: { policy: presets[preset].approval } },
    { id: "permission", config: { defaultPreset: preset, presets } },
  ];
}

/**
 * Overlay files in application order: bundle patch (unless --stock), the long-work profile (--long), generated
 * overlay, user --patch files. `sdk: true` (tui) adds the permission rows above to the generated overlay.
 * The generated overlay lives in a fresh mkdtemp dir with mode 0600; cleanup() removes it (idempotent).
 * With no generated rows no temp file is created (an empty patch file would fail dsh boot).
 *
 * ensure() is called before every spawn of a long-lived session (tui restarts, chat turns): a temp cleaner can remove
 * the generated file while the session runs, and dsh then dies at boot on every restart ("failed to read overlay").
 * A missing generated overlay is written again into a fresh mkdtemp dir (never into the old, now unowned path); a
 * missing bundle or --patch file is named in a thrown error. Returns the current file list.
 */
export function overlayFiles(o, root, { sdk = false } = {}) {
  const files = [];
  const tempDirs = [];
  if (!o.stock) files.push(join(root, "cordis.patch.yml"));
  if (o.long) files.push(join(root, LONG_PROFILE_PATCH));
  const rows = buildRows(o, root, (note) => process.stderr.write(`steak-dsh: ${note}\n`));
  if (sdk) rows.push(...sdkPermissionRows(o));
  const text = rows.length > 0 ? emitYaml(rows) : undefined;
  const writeGenerated = () => {
    const dir = mkdtempSync(join(tmpdir(), "steak-dsh-"));
    tempDirs.push(dir);
    const file = join(dir, "overlay.yml");
    writeFileSync(file, text, { mode: 0o600, flag: "wx" });
    return file;
  };
  let generatedIndex = -1;
  if (text !== undefined) {
    generatedIndex = files.length;
    files.push(writeGenerated());
  }
  files.push(...(o.patches ?? []));
  const cleanup = () => {
    while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  };
  const ensure = () => {
    if (generatedIndex >= 0 && !existsSync(files[generatedIndex])) files[generatedIndex] = writeGenerated();
    for (const [index, file] of files.entries()) {
      if (index !== generatedIndex && !existsSync(file)) throw new Error(`patch file ${file} no longer exists`);
    }
    return [...files];
  };
  return { files, cleanup, ensure };
}

/** The dsh headless argument list for one run of `task` words. */
export function headlessArgs(o, files, task) {
  const args = ["headless"];
  for (const file of files) args.push("--patch", file);
  if (o.json) args.push("--json");
  args.push("--permission-mode", o.permission, "--approval-policy", o.approvalPolicy ?? "never");
  for (const dir of o.addDirs) args.push("--add-dir", dir);
  if (o.sessionId !== undefined) args.push("--session-id", o.sessionId);
  // Everything after -- is task text for dsh, so task words can never be parsed as dsh flags.
  args.push("--", ...task);
  return args;
}
