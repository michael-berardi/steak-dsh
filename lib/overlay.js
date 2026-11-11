/**
 * The generated overlay: one temp file holding the rows the flags ask for.
 *
 * YAML emitter: JSON flow syntax is valid YAML (double-quoted strings, escaped control characters),
 * so JSON.stringify is a safe emitter — user text is never interpolated raw into the document.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Overlay files in application order: bundle patch (unless --stock), generated overlay, user --patch files.
 * The generated overlay lives in a fresh mkdtemp dir with mode 0600; cleanup() removes it (idempotent).
 * With no generated rows no temp file is created (an empty patch file would fail dsh boot).
 */
export function overlayFiles(o, root) {
  const files = [];
  let tempDir;
  if (!o.stock) files.push(join(root, "cordis.patch.yml"));
  const rows = buildRows(o, root, (note) => process.stderr.write(`steak-dsh: ${note}\n`));
  if (rows.length > 0) {
    tempDir = mkdtempSync(join(tmpdir(), "steak-dsh-"));
    const file = join(tempDir, "overlay.yml");
    writeFileSync(file, emitYaml(rows), { mode: 0o600 });
    files.push(file);
  }
  files.push(...o.patches);
  const cleanup = () => {
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  };
  return { files, cleanup };
}

/** The dsh headless argument list for one run of `task` words. */
export function headlessArgs(o, files, task) {
  const args = ["headless"];
  for (const file of files) args.push("--patch", file);
  if (o.json) args.push("--json");
  args.push("--permission-mode", o.permission, "--approval-policy", "never");
  for (const dir of o.addDirs) args.push("--add-dir", dir);
  if (o.sessionId !== undefined) args.push("--session-id", o.sessionId);
  args.push(...task);
  return args;
}
