/**
 * How a TUI session is priced, resolved once at launch. Never a guess:
 *   { plan: true }   the two login routes this bundle ships, billed to a plan and not per token
 *   a catalog row    { input, output, cacheRead, cacheWrite, tiers? } in dollars per million tokens, from the harness's
 *                    own model library, for a catalog route
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
const PLAN_PROVIDERS = new Set([CLI_PROVIDER, LOGIN_PROVIDER]);

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
  if (PLAN_PROVIDERS.has(provider)) return { plan: true };
  if (declared) return undefined;
  try {
    const find = lookup ?? (await catalogLookup(bin));
    const cost = find(provider, model)?.cost;
    const usable = cost && ["input", "output"].every((key) => Number.isFinite(cost[key]) && cost[key] >= 0);
    if (!usable) return undefined;
    const { input, output, cacheRead = 0, cacheWrite = 0, tiers } = cost;
    return { input, output, cacheRead, cacheWrite, ...(Array.isArray(tiers) && tiers.length ? { tiers } : {}) };
  } catch {
    return undefined;
  }
}
