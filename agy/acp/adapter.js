/**
 * The ACP model route. Requests keep one `agy acp` session per DSH session; the host's tools are advertised to agy
 * through the loopback MCP bridge and every tools/call becomes a real harness tool call (approvals, owned paths and
 * verify-after-edit included). Headless agy remains the fallback, selected by STEAK_DSH_AGY_TRANSPORT.
 */
import { listAgyModels, resolveAgy } from "../cli.js";
import { createAgyAdapter, buildPrompt, listedModel, EFFORT_LEVELS } from "../adapter.js";
import { AgyError, CODES, cleanAgyText } from "../errors.js";
import { AcpSession } from "./session.js";
import { effortValue } from "./protocol.js";
import { selectTransport } from "./probe.js";

const CATALOG_TTL_MS = 5 * 60_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const DEFAULT_KEY = "agy-acp-default";

/** The prompt for this turn: the newest user message, checked by the same rules as the headless route. */
export function promptText(messages) {
  const last = [...(messages ?? [])].reverse().find((message) => message?.role === "user");
  if (!last) throw new AgyError("agy ACP history must end in a user message", CODES.BAD_REQUEST);
  return buildPrompt([last]).prompt;
}

/** DSH tool result messages -> parked MCP calls in this session. Returns the call ids that were completed. */
export function toolResults(session, messages) {
  const delivered = [];
  for (const message of messages ?? []) {
    if (message?.role !== "tool" && message?.role !== "tool_result") continue;
    const id = message.toolCallId ?? message.callId;
    if (!id || !session.parked.has(id)) continue;
    const text = (Array.isArray(message.content) ? message.content : [])
      .map((block) => (block?.type === "text" ? block.text ?? "" : "")).join("")
      || (typeof message.content === "string" ? message.content : "");
    if (session.deliverToolResult(id, text, message.isError === true)) delivered.push(id);
  }
  return delivered;
}

export function createAcpAdapter(harness, { env = () => process.env, timeoutMs, report, approval } = {}) {
  const { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } = harness;
  const fail = (error) => {
    if (error instanceof LlmError) return error;
    return new LlmError(error?.message ?? String(error), typeof error?.code === "string" && error.code ? error.code : CODES.FAILED, { cause: error });
  };

  class AcpAdapter extends LlmAdapter {
    catalog;
    inflight;
    reportedCatalogFailure = false;
    sessions = new Map();
    discovered;
    discovering;

    providerInfo(provider) { return { id: provider, name: "Google Antigravity CLI (ACP)" }; }

    async rows() {
      if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.rows;
      this.inflight ??= listAgyModels(env()).then((rows) => {
        this.catalog = { rows, expires: Date.now() + CATALOG_TTL_MS };
        return rows;
      }).catch((error) => {
        if (!this.reportedCatalogFailure) { this.reportedCatalogFailure = true; report?.(`agy ACP: no models offered: ${error.message}`); }
        return undefined;
      }).finally(() => { this.inflight = undefined; });
      return this.inflight;
    }

    async discover() {
      if (this.discovered) return this.discovered;
      this.discovering ??= (async () => {
        const existing = this.sessions.get(DEFAULT_KEY);
        if (existing && !existing.closed) {
          this.discovered = existing.options;
          return this.discovered;
        }
        const rows = await this.rows();
        if (!rows?.length) throw new AgyError("agy ACP cannot discover session options without a model from `agy models`", CODES.FAILED);
        // Keep this session: the model resolution that asked for the options normally belongs to this DSH session,
        // so the first request reuses it instead of starting a second `agy acp` child.
        const probe = new AcpSession({ env: env(), report, approval });
        try {
          await probe.start({ model: rows[0].id, cwd: process.cwd(), tools: [], signal: undefined });
          this.discovered = probe.options;
          this.contextWindow = probe.contextWindow;
          probe.discovery = true;
          this.sessions.set(DEFAULT_KEY, probe);
          return this.discovered;
        } catch (error) {
          await probe.close();
          throw error;
        }
      })().finally(() => { this.discovering = undefined; });
      return this.discovering;
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
      let options;
      try { options = await this.discover(); } catch (error) { throw fail(error); }
      const efforts = options.efforts.length ? options.efforts : EFFORT_LEVELS.map((id) => ({ id, name: id }));
      const info = {
        ...listedModel(provider, row ?? { id: model, name: model }),
        reasoning: { efforts: ["off", ...efforts.map((effort) => effort.id)].map((level) => ({ id: ReasoningEffortId(level), name: level })) },
      };
      // The window is learned at first inference; until then, declare nothing rather than an invalid 0/undefined.
      if (Number.isInteger(this.contextWindow) && this.contextWindow > 0) info.context = { contextWindow: this.contextWindow };
      return info;
    }

    async sessionFor(options, key) {
      let session = this.sessions.get(key);
      if (session && (session.closed || session.model !== options.model)) { await session.close(); this.sessions.delete(key); session = undefined; }
      if (session) return session;
      // Session id may only become known after model resolution; adopt that discovery session rather than
      // starting a second long-lived child for the same DSH session.
      const adopted = [...this.sessions.entries()].find(([candidateKey, candidate]) =>
        candidateKey !== key && candidate.discovery && !candidate.closed && !candidate.promptPromise && candidate.model === options.model);
      if (adopted) {
        this.sessions.delete(adopted[0]);
        adopted[1].discovery = false;
        this.sessions.set(key, adopted[1]);
        return adopted[1];
      }
      session = new AcpSession({ env: env(), report, approval });
      try {
        await session.start({
          model: options.model,
          effort: effortValue(this.discovered ?? { efforts: EFFORT_LEVELS.map((id) => ({ id, value: id })) }, options.reasoningEffort),
          cwd: process.cwd(),
          tools: options.tools,
          signal: options.signal,
        });
        this.discovered = session.options;
      } catch (error) {
        await session.close();
        throw error;
      }
      // A bounded number of live sessions; the oldest is closed with its bridge and ACP child.
      this.sessions.set(key, session);
      if (this.sessions.size > 8) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== key) { await this.sessions.get(oldest).close(); this.sessions.delete(oldest); }
      }
      return session;
    }

    async *stream(options) {
      const internal = new AbortController();
      let timedOut = false;
      const signal = options.signal ? AbortSignal.any([options.signal, internal.signal]) : internal.signal;
      let timer;
      if (timeoutMs) timer = setTimeout(() => { timedOut = true; internal.abort(new Error("timeout")); }, timeoutMs);
      let session;
      let key = DEFAULT_KEY;
      let completed = false;
      let parkedTurn = false;
      try {
        if (!SAFE_ID.test(String(options.model ?? ""))) throw new AgyError(`agy: "${options.model}" is not a model id agy accepts`, CODES.BAD_REQUEST);
        const lastAssistant = [...(options.messages ?? [])].reverse().find((message) => message?.role === "assistant" && message?.source?.replayState?.acp);
        key = lastAssistant?.source?.replayState?.acp?.sessionKey
          ?? (typeof options.sessionId === "string" && options.sessionId ? options.sessionId : DEFAULT_KEY);
        session = await this.sessionFor(options, key);
        session.bridge.setTools(options.tools);
        const delivered = toolResults(session, options.messages);
        if (!delivered.length && !session.promptPromise) {
          session.sendPrompt(promptText(options.messages), { signal });
        } else if (!delivered.length && session.promptPromise) {
          // The tool result was not recognised: refuse instead of replaying a tool call twice.
          throw new AgyError("agy ACP has a tool call in flight; no matching harness tool result was found", CODES.ACP_PROTOCOL);
        }
        for (;;) {
          let turn;
          for await (const item of session.pump(signal)) {
            if (item.type !== "__boundary") { yield item; continue; }
            turn = item;
            break;
          }
          if (!turn) throw new AgyError("agy ACP ended the turn without a stop reason", CODES.ACP_PROTOCOL);
          if (turn.contextWindow) {
            this.contextWindow = turn.contextWindow;
            const row = this.catalog?.rows.find((candidate) => candidate.id === options.model);
            if (row) row.contextWindow = turn.contextWindow; // the window the server actually ran with
          }
          if (turn.boundary === "tools") {
            const calls = turn.tools;
            for (const [index, call] of calls.entries()) {
              const position = index;
              const block = { type: "tool-call", id: ToolCallId(call.id), name: call.name, arguments: JSON.stringify(call.args ?? {}) };
              yield { type: "block-start", index: position, blockType: "tool-call" };
              yield { type: "tool-call-delta", index: position, id: block.id, name: block.name, argumentsDelta: "" };
              yield { type: "block-end", index: position, block };
            }
            yield {
              type: "finish",
              reason: { kind: "tool-calls" },
              replayState: { acp: { version: 1, sessionKey: key, sessionId: session.sessionId, calls: calls.map((call) => call.id) } },
            };
            if (signal.aborted) throw new AgyError("agy ACP turn cancelled", CODES.CANCELLED);
            parkedTurn = true; // keep the ACP prompt and the bridge alive for the harness's tool result
            return; // the harness runs the tools, then calls stream() again with their results
          }
          yield {
            type: "finish",
            reason: { kind: turn.reason === "max_tokens" ? "max-tokens" : "stop" },
            replayState: { acp: { version: 1, sessionKey: key, sessionId: session.sessionId } },
          };
          completed = true;
          break;
        }
      } catch (error) {
        if (timedOut) throw fail(new AgyError(`agy ACP produced no answer within ${timeoutMs} ms; it was stopped`, CODES.TIMEOUT));
        throw fail(error);
      } finally {
        clearTimeout(timer);
        if (!completed && (!parkedTurn || signal.aborted)) {
          if (session) { await session.close().catch(() => {}); if (this.sessions.get(key) === session) this.sessions.delete(key); }
        }
      }
    }

    /** Close one session (with its MCP listener and ACP child), or every session when no id is given. */
    async close(sessionId) {
      const keys = sessionId ? [String(sessionId)].filter((key) => this.sessions.has(key)) : [...this.sessions.keys()];
      for (const key of keys) { await this.sessions.get(key).close(); this.sessions.delete(key); }
    }

    /** A new DSH session/branch/compaction must not inherit an ACP conversation or a bridge token. */
    reset(sessionId) { return this.close(sessionId); }
  }
  return new AcpAdapter();
}

/**
 * The route registered by the plugin: picks a transport on first use, so a machine without agy pays nothing at
 * startup. An implicit fallback always carries its reason on stderr; an explicit transport is honoured or failed.
 */
export function createAgyTransportAdapter(harness, settings = {}) {
  const { LlmAdapter } = harness;
  const headless = createAgyAdapter(harness, settings);
  let acp;
  let chosen;
  class RoutedAdapter extends LlmAdapter {
    choose() {
      if (chosen) return chosen;
      const { transport, reason } = selectTransport(settings.env?.() ?? process.env);
      if (transport === "acp") {
        acp ??= createAcpAdapter(harness, settings);
        chosen = acp;
      } else {
        chosen = headless;
        settings.report?.(`steak-dsh: agy ACP transport unavailable (${reason})`);
      }
      return chosen;
    }
    providerInfo(provider) { return this.choose().providerInfo(provider); }
    listModels(provider) { return this.choose().listModels(provider); }
    resolveModel(provider, model, signal) { return this.choose().resolveModel(provider, model, signal); }
    async *stream(options) { yield* this.choose().stream(options); }
    close(sessionId) { return chosen?.close?.(sessionId); }
    reset(sessionId) { return chosen?.reset?.(sessionId) ?? chosen?.close?.(sessionId); }
  }
  const adapter = new RoutedAdapter();
  adapter.close = (sessionId) => chosen?.close?.(sessionId);
  adapter.reset = (sessionId) => chosen?.reset?.(sessionId) ?? chosen?.close?.(sessionId);
  return adapter;
}

export { resolveAgy, cleanAgyText };
