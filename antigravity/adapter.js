/**
 * The model route: requests go to the Antigravity (Cloud Code Assist) endpoints configured by the operator, on the
 * operator's own Google sign-in. The harness keeps the conversation, the tools and the approvals; this adapter only
 * lists the account's models and generates. Nothing is read or fetched until a model is listed or a request is made.
 */
import { access } from "./auth.js";
import { call } from "./client.js";
import { PROVIDER_ID } from "./config.js";
import { AntigravityError, CODES } from "./errors.js";
import { listModels } from "./models.js";
import { buildRequest, EFFORT_LEVELS } from "./request.js";
import { sseData, Translator } from "./stream.js";

export { PROVIDER_ID };
const CATALOG_TTL_MS = 5 * 60_000;

/** Listing entry (LlmModelInfo) for one row. */
export function listedModel(provider, row) {
  return { provider, id: row.id, name: `${row.name} (Antigravity)`, inputModalities: ["text"] };
}

/**
 * @param {object} harness result of loadHarness() (LlmAdapter, LlmError, ToolCallId, ReasoningEffortId)
 * @param {{config: object, env?: () => Record<string,string|undefined>, report?: (m: string) => void, timeoutMs?: number, sleep?: Function}} settings
 */
export function createAntigravityAdapter(harness, { config, env = () => process.env, report, timeoutMs, sleep } = {}) {
  const { LlmAdapter, LlmError } = harness;
  const fail = (error) => {
    if (error instanceof LlmError) return error;
    return new LlmError(error?.message ?? String(error), typeof error?.code === "string" && error.code ? error.code : CODES.HTTP, { cause: error });
  };

  class AntigravityAdapter extends LlmAdapter {
    catalog = undefined; // { rows, expires }
    inflight = undefined;
    reportedCatalogFailure = false;

    providerInfo(provider) { return { id: provider, name: "Google Antigravity" }; }

    /** The account's rows. A failure is named to the caller; it is never turned into an empty list on a request. */
    async rows(signal) {
      if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.rows;
      this.inflight ??= (async () => {
        const session = await access({ config, env: env(), signal });
        const rows = await listModels(config, session, { signal, timeoutMs, ...(sleep ? { sleep } : {}) });
        this.catalog = { rows, expires: Date.now() + CATALOG_TTL_MS };
        return rows;
      })().finally(() => { this.inflight = undefined; });
      return this.inflight;
    }

    /** Listing is best effort for a picker: a route that cannot answer offers no models, and says why once. */
    async listModels(provider) {
      try {
        return (await this.rows()).map((row) => listedModel(provider, row));
      } catch (error) {
        if (!this.reportedCatalogFailure) { this.reportedCatalogFailure = true; report?.(`antigravity: no models offered: ${error.code ?? CODES.HTTP}: ${error.message}`); }
        return [];
      }
    }

    async resolveModel(provider, model, signal) {
      let row;
      try { row = (await this.rows(signal)).find((r) => r.id === model); } catch (error) { throw fail(error); }
      if (!row) throw fail(new AntigravityError(`Antigravity: model "${model}" is not in this account's list. Run \`steak-dsh models --provider antigravity\` to see what it offers`, CODES.HTTP));
      // Exact-route metadata (LlmResolvedModelInfo): the context window and, for a model the provider lists with thinking,
      // the effort levels it can be asked for. The provider reports no per-model levels, so all of this route's levels apply.
      return {
        ...listedModel(provider, row),
        context: { contextWindow: row.contextWindow },
        ...(row.reasoning ? { reasoning: { efforts: EFFORT_LEVELS.map((level) => ({ id: harness.ReasoningEffortId(level), name: level })) } } : {}),
      };
    }

    async *stream(options) {
      try {
        const rows = await this.rows(options.signal);
        const row = rows.find((r) => r.id === options.model);
        if (!row) throw new AntigravityError(`Antigravity: model "${options.model}" is not in this account's list. Run \`steak-dsh models --provider antigravity\` to see what it offers`, CODES.HTTP);
        const session = await access({ config, env: env(), signal: options.signal });
        const envelope = buildRequest(options, row, session.projectId, config);
        const reply = await call(config, session, "/v1internal:streamGenerateContent?alt=sse", envelope, "stream", { signal: options.signal, timeoutMs, ...(sleep ? { sleep } : {}) });
        const translator = new Translator(harness.ToolCallId);
        for await (const data of sseData(reply.chunks())) yield* translator.chunk(data);
        yield* translator.finish();
      } catch (error) {
        throw fail(error);
      }
    }
  }
  return new AntigravityAdapter();
}
