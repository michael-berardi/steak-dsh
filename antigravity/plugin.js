/**
 * Steak DSH Antigravity route: registers the `antigravity` model provider when, and only when, the operator turned it
 * on in `$DSH_HOME/steak-dsh-antigravity.json`. With no file this reads one path and loads nothing else: no adapter,
 * no network, no timers. It ships no model, no OAuth client and no account.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";

export const name = "steak-antigravity";
export const inject = ["llm"];

const packageVersion = () => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { return undefined; }
};

// A config error (a typo, a secret readable by others) stops the plugin with its own message: it must not leave the
// route silently off. With no file, or "enabled" not true, nothing below the next line is imported.
const config = loadConfig(process.env, packageVersion);
const loaded = config
  ? await Promise.all([import("./adapter.js"), import("../claude-code/harness.js")]).then(async ([adapter, { loadHarness }]) => ({ adapter, harness: await loadHarness() }))
  : undefined;

export function apply(ctx) {
  if (!config || !loaded) return;
  const note = (message) => process.stderr.write(`${message}\n`);
  const adapter = loaded.adapter.createAntigravityAdapter(loaded.harness, { config, report: note });
  ctx.effect(() => ctx.llm.registerAdapter([loaded.adapter.PROVIDER_ID], adapter), "steak-antigravity.registerAdapter()");
}
