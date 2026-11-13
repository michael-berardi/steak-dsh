/**
 * Reaching the harness's own Codex transport from a bundle plugin.
 *
 * The harness ships the wire implementation of the Codex Responses endpoint (in the LLM library it bundles) but
 * offers it only with a login kept in its own credential store. This route reuses that implementation unchanged
 * and supplies the token from the Codex CLI's login at request time, so the bundle adds no wire code of its own.
 *
 * A bundle is installed outside the harness's node_modules, so the packages are resolved from the running
 * harness's entry point. When they cannot be found (a unit test, a harness that moved them) listing models still
 * works and a request fails with CODEX_HARNESS_UNSUPPORTED.
 */
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LLM = "@deepseek-ai/dsh-llm";
const ROUTES = "@deepseek-ai/dsh-llm-pi-ai";
const LIBRARY = "@earendil-works/pi-ai";
const CATALOG_GROUP = "providers";
const CATALOG_ENTRY = "openai-codex";

/**
 * The file behind `<package>/<group>/<entry>` for a package that only declares import targets: `require.resolve`
 * cannot follow those, so the package is found on the resolver's search path and its own export map is applied.
 */
function importTarget(require, name, group, entry) {
  for (const dir of require.resolve.paths(name) ?? []) {
    const root = join(dir, name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const target = manifest.exports?.[`./${group}/*`];
    const pattern = typeof target === "string" ? target : (target?.import ?? target?.default);
    if (typeof pattern !== "string" || !pattern.includes("*")) throw new Error(`${name} does not export ./${group}/*`);
    return join(root, pattern.replace("*", entry));
  }
  throw new Error(`${name} was not found beside the harness`);
}

/** The adapter contract defaults, as the harness documents them in LlmAdapter. */
class FallbackAdapter {
  providerInfo(provider) { return { id: provider, name: provider }; }
  providerRetryPolicy() { return undefined; }
  imageRequestPricing() { return undefined; }
  imageRequestTarget(_provider, _model, image) { return { width: image.width, height: image.height, maxBytes: image.bytes }; }
  listModels() { return Promise.resolve([]); }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
  }
}

class FallbackError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "LlmError";
    this.code = code;
  }
}

/**
 * @param {{entry?: string}} [options] entry: the file to resolve from (defaults to the process entry point).
 * @returns {Promise<{LlmAdapter: Function, LlmError: Function, ReasoningEffortId: Function, RouteAdapter?: Function, catalogProvider?: Function, source: string, missing?: string}>}
 */
export async function loadCodexHarness({ entry = process.argv[1] } = {}) {
  const fallback = { LlmAdapter: FallbackAdapter, LlmError: FallbackError, ReasoningEffortId: (id) => id, source: "fallback" };
  let require;
  let llm;
  try {
    if (!entry) throw new Error("no entry point");
    require = createRequire(realpathSync(entry));
    llm = await import(pathToFileURL(require.resolve(LLM)).href);
    if (typeof llm.LlmAdapter !== "function" || typeof llm.LlmError !== "function") throw new Error("unexpected exports");
  } catch (error) {
    return { ...fallback, missing: `${LLM}: ${error.message}` };
  }
  const base = {
    LlmAdapter: llm.LlmAdapter,
    LlmError: llm.LlmError,
    ReasoningEffortId: typeof llm.ReasoningEffortId === "function" ? llm.ReasoningEffortId : (id) => id,
    source: "harness",
  };
  try {
    const routesPath = require.resolve(ROUTES);
    const routes = await import(pathToFileURL(routesPath).href);
    const catalog = await import(pathToFileURL(importTarget(createRequire(routesPath), LIBRARY, CATALOG_GROUP, CATALOG_ENTRY)).href);
    if (typeof routes.PiAiAdapter !== "function" || typeof catalog.openaiCodexProvider !== "function") throw new Error("unexpected exports");
    return { ...base, RouteAdapter: routes.PiAiAdapter, catalogProvider: catalog.openaiCodexProvider };
  } catch (error) {
    return { ...base, missing: error.message };
  }
}
