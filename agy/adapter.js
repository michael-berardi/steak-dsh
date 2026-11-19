/**
 * The model route: each request runs one headless `agy -p` on the operator's own agy sign-in. agy keeps its own agent
 * loop, tools and permission rules; the harness gets the text agy streams, with agy's tool steps shown as progress.
 * Nothing is started until a model is listed or a request is made, so a machine without agy pays nothing.
 */
import { listAgyModels, resolveAgy, runAgy } from "./cli.js";
import { AgyError, CODES } from "./errors.js";
import { AgyTranslator } from "./stream.js";

export const PROVIDER_ID = "agy";
const CATALOG_TTL_MS = 5 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
/** agy's own effort levels. "off" is not one of them: the nearest is low. */
export const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const OFF_LEVELS = new Set(["off", "none", "minimal"]);

/** The agy --effort value for a harness effort, undefined for none requested, or a named error. */
export function agyEffort(effort) {
  if (effort === undefined || effort === null || effort === "") return undefined;
  const level = String(effort).toLowerCase();
  if (OFF_LEVELS.has(level)) return "low";
  if (EFFORT_LEVELS.includes(level)) return level;
  throw new AgyError(`agy has no reasoning effort "${effort}"; use off, ${EFFORT_LEVELS.join(", ")}`, CODES.BAD_REQUEST);
}

function textOf(content, role) {
  if (typeof content === "string") return content;
  let out = "";
  for (const block of content ?? []) {
    if (block?.type === "text") out += block.text ?? "";
    else if (block?.type === "reasoning" || block?.type === "thinking") continue;
    else if (role === "user") throw new AgyError(`agy takes text only: a "${block?.type}" block in the request cannot be sent`, CODES.BAD_REQUEST);
  }
  return out;
}

/** The agy conversation a previous reply of this route recorded, or undefined. */
function savedConversation(message) {
  const state = message?.source?.replayState;
  const carrier = state?.agy ?? state?.response?.agy;
  return carrier?.version === 1 && typeof carrier.conversationId === "string" && carrier.conversationId ? carrier.conversationId : undefined;
}

/**
 * The prompt for this request and the agy conversation to resume. When the last assistant reply came from agy, only
 * what the user said since then is sent and agy resumes its own conversation (it already holds the history, tool
 * results included). Otherwise the visible conversation is sent as text.
 */
export function buildPrompt(messages) {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool");
  const lastAssistant = turns.findLastIndex((m) => m.role === "assistant");
  const conversationId = lastAssistant >= 0 ? savedConversation(turns[lastAssistant]) : undefined;
  const fresh = conversationId ? turns.slice(lastAssistant + 1) : turns;
  const users = fresh.filter((m) => m.role === "user");
  if (turns.at(-1)?.role !== "user") throw new AgyError("agy history must end in a user message", CODES.BAD_REQUEST);
  let prompt;
  if (users.length === 1 && fresh.length === 1) {
    prompt = textOf(users[0].content, "user");
  } else if (conversationId) {
    prompt = users.map((m) => textOf(m.content, "user")).join("\n\n");
  } else {
    prompt = fresh.map((m) => `${m.role === "assistant" ? "Assistant" : m.role === "tool" ? "Tool result" : "User"}: ${textOf(m.content, m.role)}`).join("\n\n");
  }
  if (!prompt.trim()) throw new AgyError("agy request has no text to send", CODES.BAD_REQUEST);
  return { prompt, conversationId };
}

/** Listing entry (LlmModelInfo) for one row. */
export function listedModel(provider, row) {
  return { provider, id: row.id, name: `${row.name} (Antigravity CLI)`, inputModalities: ["text"] };
}

/**
 * @param {object} harness result of loadHarness() (LlmAdapter, LlmError, ReasoningEffortId)
 * @param {{env?: () => Record<string, string|undefined>, timeoutMs?: number, report?: (message: string) => void}} [settings]
 */
export function createAgyAdapter(harness, { env = () => process.env, timeoutMs, report } = {}) {
  const { LlmAdapter, LlmError } = harness;
  const fail = (error) => {
    if (error instanceof LlmError) return error;
    return new LlmError(error?.message ?? String(error), typeof error?.code === "string" && error.code ? error.code : CODES.FAILED, { cause: error });
  };

  class AgyAdapter extends LlmAdapter {
    catalog = undefined; // { rows, expires }
    inflight = undefined;
    reportedCatalogFailure = false;

    providerInfo(provider) { return { id: provider, name: "Google Antigravity CLI (agy)" }; }

    /** The plan's rows, or undefined when agy cannot list them (the reason is reported once; a request names it again). */
    async rows() {
      if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.rows;
      this.inflight ??= listAgyModels(env()).then((rows) => {
        this.catalog = { rows, expires: Date.now() + CATALOG_TTL_MS };
        return rows;
      }).catch((error) => {
        if (!this.reportedCatalogFailure) { this.reportedCatalogFailure = true; report?.(`agy: no models offered: ${error.message}`); }
        return undefined;
      }).finally(() => { this.inflight = undefined; });
      return this.inflight;
    }

    async listModels(provider) {
      const rows = await this.rows();
      return rows ? rows.map((row) => listedModel(provider, row)) : [];
    }

    async resolveModel(provider, model) {
      const rows = await this.rows();
      const row = rows?.find((candidate) => candidate.id === model);
      if (rows && !row) {
        throw fail(new AgyError(`agy: model "${model}" is not in this plan's list; run \`steak-dsh models --provider agy\` to see what the plan offers`, CODES.MODEL_UNAVAILABLE));
      }
      return {
        ...listedModel(provider, row ?? { id: model, name: model }),
        // agy states no context size and manages its own context; none is declared here.
        // "off" is offered so the harness accepts steak-dsh's --effort off; agy has no off, so it is sent as low.
        reasoning: { efforts: ["off", ...EFFORT_LEVELS].map((level) => ({ id: harness.ReasoningEffortId(level), name: level })) },
      };
    }

    async *stream(options) {
      const internal = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
      const queue = [];
      let wake;
      let ended = false;
      let translator;
      let request;
      let completed = false;
      try {
        if (!SAFE_ID.test(String(options.model ?? ""))) throw new AgyError(`agy: "${options.model}" is not a model id agy accepts`, CODES.BAD_REQUEST);
        const { prompt, conversationId } = buildPrompt(options.messages);
        const effort = agyEffort(options.reasoningEffort);
        const cwd = process.cwd();
        translator = new AgyTranslator(options.model);
        request = {
          // Never --dangerously-skip-permissions: agy's own permission rules decide what its tools may do.
          args: [
            "-p", prompt, "--model", options.model, "--output-format", "stream-json", "--disable-slash-commands",
            ...(effort ? ["--effort", effort] : []),
            "--add-dir", cwd,
            ...(conversationId ? ["--conversation", conversationId] : []),
          ],
          cwd,
          env: env(),
          signal,
          timeoutMs,
          onEvent: (event) => { queue.push(...translator.event(event)); wake?.(); },
          onNotice: (line) => report?.(`agy: ${line}`),
        };
        request.command = await resolveAgy(request.env);
      } catch (error) {
        throw fail(error);
      }

      const done = runAgy(request).then(
        ({ result }) => {
          try { queue.push(...translator.finish(result)); completed = true; } finally { ended = true; wake?.(); }
        },
        (error) => { ended = true; wake?.(); return Promise.reject(error); },
      );
      done.catch(() => {}); // observed below; never an unhandled rejection
      try {
        for (;;) {
          if (queue.length) { yield queue.shift(); continue; }
          if (ended) break;
          await new Promise((resolve) => { wake = resolve; });
        }
        await done;
      } catch (error) {
        throw fail(error);
      } finally {
        // A consumer that stops early, or an abort, stops agy's process group, and the stop is finished before we return.
        if (!completed) { internal.abort(new Error("agy request ended")); await done.catch(() => {}); }
      }
    }
  }
  return new AgyAdapter();
}
