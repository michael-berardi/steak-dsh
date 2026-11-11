/** Flag parsing for `steak-dsh run` and `steak-dsh chat`. Bad flags are named UsageErrors (exit 2). */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { UsageError } from "./errors.js";

const VALUE_FLAGS = new Set([
  "--model", "--base-url", "--api", "--key-env", "--context-window", "--effort", "--compat",
  "--permission", "--add-dir", "--owned-path", "--session-id", "--patch", "--verify",
]);
const BOOL_FLAGS = new Set(["--no-shell", "--json", "--stock"]);
const APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const PERMISSIONS = new Set(["read-only", "workspace-write", "danger-full-access"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse options up to the first positional word; everything after it (or after `--`) is the task.
 * Returns { options, task }. `allowTask: false` (chat) rejects positional words.
 */
export function parseOptions(argv, { allowTask = true } = {}) {
  const o = {
    model: undefined, provider: undefined, baseUrl: undefined, api: undefined, keyEnv: undefined,
    contextWindow: undefined, effort: undefined, effortWire: undefined, compat: undefined,
    permission: "workspace-write", addDirs: [], ownedPaths: [], sessionId: undefined,
    json: false, patches: [], stock: false, noShell: false, verify: undefined,
  };
  const task = [];
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (positional || arg === "-" || !arg.startsWith("--")) {
      task.push(arg);
      positional = true;
      continue;
    }
    if (arg === "--") { positional = true; continue; }
    if (BOOL_FLAGS.has(arg)) {
      if (arg === "--no-shell") o.noShell = true;
      if (arg === "--json") o.json = true;
      if (arg === "--stock") o.stock = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new UsageError(`unknown option ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`option ${arg} needs a value`);
    switch (arg) {
      case "--model": {
        const slash = value.indexOf("/");
        if (slash <= 0 || slash === value.length - 1) {
          throw new UsageError(`--model must be <provider>/<model-id>, got "${value}"`);
        }
        o.provider = value.slice(0, slash);
        o.model = value.slice(slash + 1); // the model id may itself contain slashes
        break;
      }
      case "--base-url": o.baseUrl = value; break;
      case "--api":
        if (!APIS.has(value)) throw new UsageError(`--api must be one of ${[...APIS].join(", ")}, got "${value}"`);
        o.api = value;
        break;
      case "--key-env":
        if (!ENV_NAME.test(value)) throw new UsageError(`--key-env must be an environment variable NAME, got "${value}"`);
        o.keyEnv = value;
        break;
      case "--context-window":
        if (!/^\d+$/.test(value) || Number(value) <= 0) throw new UsageError(`--context-window must be a positive integer, got "${value}"`);
        o.contextWindow = Number(value);
        break;
      case "--effort": {
        // <level> or <level>=<wire value>, for gateways that spell a level differently on the wire.
        const eq = value.indexOf("=");
        o.effort = eq < 0 ? value : value.slice(0, eq);
        o.effortWire = eq < 0 ? value : value.slice(eq + 1);
        if (!/^[a-z]+$/.test(o.effort) || !o.effortWire) throw new UsageError(`--effort must be <level> or <level>=<wire value>, got "${value}"`);
        break;
      }
      case "--compat": {
        let parsed;
        try { parsed = JSON.parse(value); } catch (error) { throw new UsageError(`--compat is not valid JSON: ${error.message}`); }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new UsageError("--compat must be a JSON object");
        }
        o.compat = parsed;
        break;
      }
      case "--permission":
        if (!PERMISSIONS.has(value)) throw new UsageError(`--permission must be one of ${[...PERMISSIONS].join(", ")}, got "${value}"`);
        o.permission = value;
        break;
      case "--add-dir":
        if (!isAbsolute(value)) throw new UsageError(`--add-dir must be an absolute path, got "${value}"`);
        o.addDirs.push(value);
        break;
      case "--owned-path":
        if (!isAbsolute(value)) throw new UsageError(`--owned-path must be an absolute path, got "${value}"`);
        o.ownedPaths.push(value);
        break;
      case "--session-id": o.sessionId = value; break;
      case "--patch":
        if (!existsSync(value)) throw new UsageError(`--patch file not found: ${value}`);
        o.patches.push(value);
        break;
      case "--verify": o.verify = value; break;
    }
  }
  if (o.baseUrl !== undefined) {
    if (o.model === undefined) throw new UsageError("--base-url needs --model <provider>/<model-id> to name the route");
    if (o.api === undefined) throw new UsageError("--base-url needs --api <openai-completions|openai-responses|anthropic-messages>");
    if (o.keyEnv === undefined) throw new UsageError("--base-url needs --key-env <ENV_NAME>");
  }
  for (const [flag, present] of [["--api", o.api], ["--key-env", o.keyEnv], ["--compat", o.compat], ["--context-window", o.contextWindow]]) {
    if (present !== undefined && o.baseUrl === undefined) throw new UsageError(`${flag} only applies to a gateway route; add --base-url (and --model)`);
  }
  if (!allowTask && task.length > 0) throw new UsageError(`chat takes no task arguments, got "${task.join(" ")}"`);
  if (allowTask && task.length === 0) throw new UsageError("run needs a task: words, or - to read it from stdin");
  return { options: o, task };
}

/** Refuse before launch when the named key variable is unset. The value itself is never read or printed. */
export function requireKeyEnv(o, env = process.env) {
  if (o.keyEnv !== undefined && !env[o.keyEnv]) {
    throw new UsageError(`--key-env ${o.keyEnv} is unset or empty; export ${o.keyEnv} before running`);
  }
}
