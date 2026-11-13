/**
 * The model route: an adapter that runs each request through the Claude Code CLI on the user's own login.
 */
import { discoverClaudeModels, getClaudeStatus, processEnvironment, runClaudeRequest, closeClaudeProcesses } from "./claude-cli.js";
import { CODES } from "./errors.js";
import { plainModel, listedModel, resolvedModel, rowsFromDiscovery } from "./models.js";
import { EventTranslator, normalizeErrorMessage } from "./stream.js";
import {
  buildExtraBody, getInitialSystemMessages, getInitialUserPrefix, prepareFrames, prepareTools, systemPromptText,
} from "./transcript.js";

export const PROVIDER_ID = "claude-code";
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_WAIT_MS = 25_000;

/** A simple pull queue so the CLI's event callback can feed an async generator. */
class ChunkQueue {
  items = [];
  waiter = undefined;
  ended = false;
  push(chunks) { for (const chunk of chunks) this.items.push(chunk); this.wake(); }
  end() { this.ended = true; this.wake(); }
  wake() { const w = this.waiter; this.waiter = undefined; w?.(); }
  async next() {
    for (;;) {
      if (this.items.length) return { value: this.items.shift() };
      if (this.ended) return { done: true };
      await new Promise((resolve) => { this.waiter = resolve; });
    }
  }
}

/**
 * @param {object} harness result of loadHarness()
 * @param {{env?: () => Record<string, string|undefined>, timeoutMs?: number, report?: (message: string) => void, upstreamUrl?: string}} [settings]
 * `upstreamUrl` is a test seam (HTTPS, or loopback HTTP); the plugin never sets it, so requests go to the vendor's API.
 */
export function createClaudeCodeAdapter(harness, { env = () => process.env, timeoutMs, report, upstreamUrl } = {}) {
  const { LlmAdapter, LlmError } = harness;

  const fail = (error) => {
    if (error instanceof LlmError) return error;
    const { message, code } = normalizeErrorMessage(error);
    return new LlmError(message, typeof code === "string" && code ? code : CODES.FAILED, { cause: error });
  };

  class ClaudeCodeAdapter extends LlmAdapter {
    catalog = undefined; // { rows, expires }
    inflight = undefined;
    reportedCatalogFailure = false;

    providerInfo(provider) {
      return { id: provider, name: "Claude Code (subscription login)" };
    }

    /** Catalog rows from the installed CLI, or undefined when it is missing, logged out or does not answer. */
    async rows(signal) {
      if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.rows;
      if (!this.inflight) {
        const run = (async () => {
          const status = await getClaudeStatus(env(), undefined);
          if (!status.available || !status.loggedIn) {
            if (status.detail && !this.reportedCatalogFailure) { this.reportedCatalogFailure = true; report?.(`claude-code: no models offered: ${status.detail}`); }
            return undefined;
          }
          const rows = rowsFromDiscovery(await discoverClaudeModels(env(), undefined));
          this.catalog = { rows, expires: Date.now() + CATALOG_TTL_MS };
          return rows;
        })().catch((error) => {
          if (!this.reportedCatalogFailure) { this.reportedCatalogFailure = true; report?.(`claude-code: no models offered: ${error.message}`); }
          return undefined;
        }).finally(() => { this.inflight = undefined; });
        this.inflight = run;
      }
      signal?.throwIfAborted();
      return Promise.race([
        this.inflight,
        new Promise((resolve) => setTimeout(resolve, CATALOG_WAIT_MS, undefined).unref?.()),
      ]);
    }

    async listModels(provider) {
      const rows = await this.rows();
      return rows ? rows.map((row) => listedModel(provider, row)) : [];
    }

    async resolveModel(provider, model, signal) {
      const rows = await this.rows(signal);
      const row = rows?.find((candidate) => candidate.id === model);
      return row ? resolvedModel(provider, row, harness.ReasoningEffortId) : plainModel(provider, model);
    }

    async *stream(options) {
      const internal = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
      const queue = new ChunkQueue();
      let translator;
      let request;
      let completed = false;
      try {
        // Cheap checks first, so a bad request never starts a process.
        const frames = prepareFrames(options.messages);
        const prepared = prepareTools(options.tools);
        translator = new EventTranslator(prepared.names, harness.ToolCallId);
        const row = this.catalog?.rows.find((candidate) => candidate.id === options.model);
        request = {
          model: row?.native ?? options.model, // a listed id goes to the CLI under the CLI's own name for the row
          cwd: process.cwd(),
          frames,
          systemPrompt: systemPromptText(options),
          manifest: prepared.manifest,
          extraBody: buildExtraBody(prepared.nativeTools, {
            maxTokens: options.maxTokens,
            reasoningEffort: options.reasoningEffort,
            adaptive: row ? row.adaptive : true,
          }),
          toolNames: prepared.names,
          signal,
          timeoutMs,
          upstreamUrl,
          env: env(),
          initialUserPrefix: getInitialUserPrefix(options.messages),
          initialSystemMessages: getInitialSystemMessages(options.messages),
          sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
          onEvent: (event) => queue.push(translator.event(event)),
        };
      } catch (error) {
        throw fail(error);
      }

      const done = runClaudeRequest(request).then(
        (response) => {
          queue.push(translator.finish(response.message, response.usage, response));
          completed = true;
          queue.end();
        },
        (error) => { queue.end(); return Promise.reject(error); },
      );
      done.catch(() => {}); // observed below; never an unhandled rejection
      try {
        for (;;) {
          const next = await queue.next();
          if (next.done) break;
          yield next.value;
        }
        await done;
      } catch (error) {
        throw fail(error);
      } finally {
        // A consumer that stops early, or an abort, stops the process tree.
        if (!completed) internal.abort(new Error("Claude Code request ended"));
      }
    }
  }
  const adapter = new ClaudeCodeAdapter();
  adapter.close = (sessionId) => closeClaudeProcesses(sessionId);
  return adapter;
}

export { processEnvironment };
