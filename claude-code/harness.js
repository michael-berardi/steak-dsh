/**
 * Reaching the harness's own LLM package from a bundle plugin.
 *
 * A bundle is installed outside the harness's node_modules, so a bare import of the LLM package fails there.
 * The running harness is the process entry point: resolving from its real path finds the package it loads
 * itself. When that fails (a unit test, a different launcher) a local base class and error type carry the same
 * contract, because the adapter registry accepts any object that implements it.
 */
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const PACKAGE = "@deepseek-ai/dsh-llm";

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
 * @returns {Promise<{LlmAdapter: Function, LlmError: Function, ReasoningEffortId: Function, ToolCallId: Function, source: string}>}
 */
export async function loadHarness({ entry = process.argv[1] } = {}) {
  try {
    if (!entry) throw new Error("no entry point");
    const resolved = createRequire(realpathSync(entry)).resolve(PACKAGE);
    const mod = await import(pathToFileURL(resolved).href);
    if (typeof mod.LlmAdapter === "function" && typeof mod.LlmError === "function") {
      return {
        LlmAdapter: mod.LlmAdapter,
        LlmError: mod.LlmError,
        ReasoningEffortId: typeof mod.ReasoningEffortId === "function" ? mod.ReasoningEffortId : (id) => id,
        ToolCallId: typeof mod.ToolCallId === "function" ? mod.ToolCallId : (id) => id,
        source: "harness",
      };
    }
  } catch {
    // fall through to the local contract
  }
  return { LlmAdapter: FallbackAdapter, LlmError: FallbackError, ReasoningEffortId: (id) => id, ToolCallId: (id) => id, source: "fallback" };
}
