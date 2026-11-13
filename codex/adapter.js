/**
 * The model route: requests go to the Codex Responses endpoint on the user's own ChatGPT login.
 *
 * The wire work is the harness's: this adapter hands each request to the harness's own route adapter, built around
 * the Codex transport the harness already ships. What this file adds is where the token comes from (the Codex CLI's
 * login, read at request time) and where the model list comes from (the backend, for the logged-in account).
 */
import { codexAccess, TOKEN_URL } from "./auth.js";
import { CODES, CodexError } from "./errors.js";
import { checkedUrl, clientVersion, DEFAULT_BASE_URL, fetchCodexModels } from "./models.js";

export const PROVIDER_ID = "openai-codex";
const WIRE = "openai-codex-responses";
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_WAIT_MS = 25_000;
/** Used only for a model the backend does not describe (an id requested by hand): the backend still decides. */
const UNDESCRIBED_CONTEXT = 200_000;
const UNDESCRIBED_MAX_TOKENS = 64_000;
const NO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
/** The harness library's effort levels, lowest first. A level the backend does not report for a model is refused. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Listing entry (LlmModelInfo) for one backend row. */
export function listedModel(provider, row) {
  return {
    provider,
    id: row.id,
    name: `${row.name ?? row.id} (Codex)`,
    ...(row.description ? { description: row.description } : {}),
    inputModalities: ["text"],
  };
}

/**
 * Which of the library's levels a model takes, from the efforts the backend reports for it. A level maps to the
 * word sent on the wire, or to null when the backend does not report it.
 */
export function levelMap(efforts, known = {}) {
  // "Off" is sent only when the backend reports a way to switch thinking off; otherwise a request without an effort
  // carries none and the model's own default applies.
  const map = { off: efforts.includes("none") ? "none" : null };
  for (const level of LEVELS) {
    const spelled = typeof known?.[level] === "string" && efforts.includes(known[level]) ? known[level] : null;
    map[level] = efforts.includes(level) ? level : spelled;
  }
  return map;
}

/** The library's model descriptor for one id: the backend row first, the installed description of the id second. */
export function describeModel(id, row, known, baseUrl) {
  const efforts = row?.efforts ?? [];
  return {
    type: "chat",
    ...known,
    id,
    name: row?.name ?? known?.name ?? id,
    api: known?.api ?? WIRE,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: efforts.length ? true : (known?.reasoning ?? true),
    ...(efforts.length ? { thinkingLevelMap: levelMap(efforts, known?.thinkingLevelMap) } : {}),
    input: ["text"],
    cost: known?.cost ?? NO_COST,
    contextWindow: row?.contextWindow ?? known?.contextWindow ?? UNDESCRIBED_CONTEXT,
    maxTokens: known?.maxTokens ?? UNDESCRIBED_MAX_TOKENS,
  };
}

/**
 * @param {object} harness result of loadCodexHarness()
 * @param {{env?: () => Record<string, string|undefined>, report?: (message: string) => void, baseUrl?: string, tokenUrl?: string, fetchImpl?: typeof fetch, now?: () => number}} [settings]
 * `baseUrl` and `tokenUrl` are test seams (HTTPS, or HTTP on this machine); unset, requests go to the vendor.
 */
export function createCodexAdapter(harness, { env = () => process.env, report, baseUrl, tokenUrl, fetchImpl, now } = {}) {
  const { LlmAdapter, LlmError, RouteAdapter, catalogProvider } = harness;
  const base = baseUrl === undefined ? DEFAULT_BASE_URL : checkedUrl(baseUrl, "baseUrl");
  const renewAt = tokenUrl === undefined ? TOKEN_URL : checkedUrl(tokenUrl, "tokenUrl");
  const access = () => codexAccess({ env: env(), tokenUrl: renewAt, report, ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}) });

  const fail = (error) => {
    if (error instanceof LlmError) return error;
    if (error instanceof CodexError) return new LlmError(error.message, error.code, { cause: error });
    return new LlmError(error?.message ?? String(error), typeof error?.code === "string" && error.code ? error.code : "CODEX_FAILED", { cause: error });
  };

  class CodexAdapter extends LlmAdapter {
    catalog = undefined; // { rows, expires }
    inflight = undefined;
    reportedCatalogFailure = false;
    requested = new Set(); // ids asked for by hand that the backend list does not carry
    built = undefined; // { key, profiles }
    inner = undefined;
    installed = undefined;

    providerInfo(provider) {
      return { id: provider, name: "Codex (ChatGPT login)" };
    }

    /** The account's rows from the backend, or undefined when there is no login or the backend does not answer. */
    async rows(signal) {
      if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.rows;
      if (!this.inflight) {
        const run = (async () => {
          const rows = await fetchCodexModels({ access: await access(), baseUrl: base, version: clientVersion(env()), ...(fetchImpl ? { fetchImpl } : {}) });
          this.catalog = { rows, expires: Date.now() + CATALOG_TTL_MS };
          return rows;
        })().catch((error) => {
          if (!this.reportedCatalogFailure) {
            this.reportedCatalogFailure = true;
            report?.(`codex: no models offered: ${error.code ?? "CODEX_FAILED"}: ${error.message}`);
          }
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

    /** The harness's route adapter over the current rows. Rebuilt only when the set of models changes. */
    route() {
      if (!RouteAdapter || !catalogProvider) {
        throw new LlmError(
          `The Codex route needs the harness's own Codex transport, which this harness build does not expose${harness.missing ? ` (${harness.missing})` : ""}.`,
          CODES.HARNESS_UNSUPPORTED,
        );
      }
      this.installed ??= catalogProvider();
      const rows = this.catalog?.rows ?? [];
      const key = JSON.stringify([rows.map((row) => [row.id, row.contextWindow, row.efforts]), [...this.requested]]);
      if (this.built?.key !== key) {
        const known = new Map(this.installed.getModels().map((model) => [model.id, model]));
        const models = rows.map((row) => describeModel(row.id, row, known.get(row.id), base));
        for (const id of this.requested) {
          if (!rows.some((row) => row.id === id)) models.push(describeModel(id, undefined, known.get(id), base));
        }
        const name = this.providerInfo(PROVIDER_ID).name;
        const provider = {
          id: PROVIDER_ID,
          name,
          baseUrl: base,
          // One method only: the token this route hands over. The library's own login store is never consulted.
          auth: { apiKey: { name, resolve: ({ credential }) => Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: name }) } },
          getModels: () => models,
          stream: (model, context, options) => this.installed.stream(model, context, options),
          streamSimple: (model, context, options) => this.installed.streamSimple(model, context, options),
        };
        const profile = {
          provider: PROVIDER_ID,
          displayName: name,
          transport: "sse",
          streamIdleTimeoutMs: 300_000,
          maxRequestImageBytes: 20 * 1024 * 1024,
          maxRequestImages: 50,
          imageOffloadCountQuantum: 10,
          requestImagePixelBudget: 4_194_304,
          requestImageMaxBytes: 1_048_576,
          configuredMaxTokens: new Map(),
          modelErrors: new Map(),
          piProvider: provider,
        };
        this.built = { key, profiles: new Map([[PROVIDER_ID, profile]]) };
      }
      this.inner ??= new RouteAdapter({
        profiles: () => this.built.profiles,
        // Read at request time, renewed first when it is at its expiry. Never stored on the adapter.
        resolveApiKey: async () => (await access()).token,
        auth: {
          credentials: {
            read: () => Promise.resolve(undefined),
            list: () => Promise.resolve([]),
            modify: () => Promise.reject(new LlmError("The Codex route keeps no credentials of its own", CODES.NOT_LOGGED_IN)),
            delete: () => Promise.resolve(),
          },
          authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
        },
      });
      return this.inner;
    }

    async listModels(provider) {
      const rows = await this.rows();
      return rows ? rows.map((row) => listedModel(provider, row)) : [];
    }

    async resolveModel(provider, model, signal) {
      const rows = await this.rows(signal);
      const row = rows?.find((candidate) => candidate.id === model);
      if (!RouteAdapter || !catalogProvider) return row ? listedModel(provider, row) : { provider, id: model, name: model, inputModalities: ["text"] };
      if (!row) this.requested.add(model);
      try {
        const info = await this.route().resolveModel(provider, model, signal);
        return row ? { ...info, name: listedModel(provider, row).name, ...(row.description ? { description: row.description } : {}) } : info;
      } catch (error) {
        throw fail(error);
      }
    }

    async *stream(options) {
      try {
        const rows = await this.rows(options.signal);
        if (!rows?.some((row) => row.id === options.model)) this.requested.add(options.model);
        yield* this.route().stream({ ...options, provider: PROVIDER_ID });
      } catch (error) {
        throw fail(error);
      }
    }
  }
  return new CodexAdapter();
}
