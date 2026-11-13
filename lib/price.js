/**
 * How a TUI session is priced, resolved once at launch. Never a guess:
 *   a catalog row    { input, output, cacheRead, cacheWrite, tiers? } in dollars per million tokens, from the harness's
 *                    own model library. The two login routes this bundle ships are looked up under the library's
 *                    name for the same vendor, so the figure is the list price of the work done on the plan.
 *   { plan: true }   a login route whose model the library does not list: billed to a plan, shown as 0
 *   undefined        anything else (a gateway declared with --base-url, a model the library does not list, or a library
 *                    that could not be loaded): the band then shows no cost
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PROVIDER_ID as CLI_PROVIDER } from "../claude-code/adapter.js";
import { PROVIDER_ID as LOGIN_PROVIDER } from "../codex/adapter.js";
import { importTarget } from "../codex/harness.js";

const ROUTES = "@deepseek-ai/dsh-llm-pi-ai";
const LIBRARY = "@earendil-works/pi-ai";
/** Login route -> the provider the model library files the same models under. */
const PLAN_PROVIDERS = new Map([[CLI_PROVIDER, "anthropic"], [LOGIN_PROVIDER, LOGIN_PROVIDER]]);

async function catalogLookup(bin) {
  const routes = createRequire(realpathSync(bin)).resolve(ROUTES);
  const library = await import(pathToFileURL(importTarget(createRequire(routes), LIBRARY, "providers", "all")).href);
  if (typeof library.getBuiltinModel !== "function") throw new Error("the model library has no getBuiltinModel");
  return library.getBuiltinModel;
}

/**
 * @param {{provider?: string, model?: string, bin?: string, declared?: boolean, lookup?: (provider: string, model: string) => any}} o
 *   declared: the route was declared on the command line (--base-url), so the library's row for that name is not its price.
 */
export async function resolvePrice({ provider, model, bin, declared = false, lookup } = {}) {
  if (!provider || !model) return undefined;
  const plan = PLAN_PROVIDERS.has(provider);
  const none = plan ? { plan: true } : undefined;
  if (declared && !plan) return undefined;
  try {
    const find = lookup ?? (await catalogLookup(bin));
    const cost = find(plan ? PLAN_PROVIDERS.get(provider) : provider, model)?.cost;
    const usable = cost && ["input", "output"].every((key) => Number.isFinite(cost[key]) && cost[key] >= 0);
    if (!usable) return none;
    const { input, output, cacheRead = 0, cacheWrite = 0, tiers } = cost;
    return { input, output, cacheRead, cacheWrite, ...(Array.isArray(tiers) && tiers.length ? { tiers } : {}) };
  } catch {
    return none;
  }
}
