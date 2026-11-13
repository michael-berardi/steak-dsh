/**
 * The pure state reducer. Input: actions (wire notifications, server requests, user intents, child lifecycle).
 * Output: the next state. No I/O, no clocks, no randomness: the same action list always gives the same state.
 *
 * The phase vocabulary and its transitions are ported from the Steak Pi companion model:
 *   ready thinking responding tool waiting compacting complete error stopped
 */
import { oneLine, truncatePlain } from "./width.js";

export const TOOL_PREVIEW_LINES = 10;

/**
 * Dollars for one request. `price` is `{ plan: true }` (a login route billed to a plan: always 0), a catalog row
 * `{ input, output, cacheRead, cacheWrite, tiers? }` in dollars per million tokens, or undefined (unknown: no cost).
 * A tier applies when the request's prompt (input plus both cache parts) exceeds its `inputTokensAbove`.
 */
export function requestCost(price, { input, output, cacheRead, cacheWrite }) {
  if (!price || price.plan) return 0;
  const prompt = input + cacheRead + cacheWrite;
  let rates = price;
  for (const tier of Array.isArray(price.tiers) ? price.tiers : []) {
    if (Number.isFinite(tier?.inputTokensAbove) && prompt > tier.inputTokensAbove && tier.inputTokensAbove >= (rates.inputTokensAbove ?? -1)) rates = tier;
  }
  const rate = (key) => (Number.isFinite(rates[key]) ? rates[key] : Number.isFinite(price[key]) ? price[key] : 0);
  return (input * rate("input") + output * rate("output") + cacheRead * rate("cacheRead") + cacheWrite * rate("cacheWrite")) / 1e6;
}

export function initialState({ model, effort, sessionId, cwd, contextWindow, price, resumed = false } = {}) {
  return {
    phase: "ready",
    detail: resumed ? "resumed" : "new session",
    hadError: false,
    activeTools: {}, // callId -> tool name
    model: model ?? "", // the id as the user named it; the band shortens it
    effort: effort ?? "",
    sessionId: sessionId ?? "",
    cwd: cwd ?? "",
    contextWindow: contextWindow, // undefined until request/context (or --context-window) tells us
    contextTokens: undefined, // occupancy of the most recent model request, never invented
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 },
    price, // how this session is priced; undefined means unknown
    costReported: false, // the route itself reported a cost for a request: that figure is used, not tokens times price
    blocks: [], // transcript, oldest first
    prompt: undefined, // the open approval / question, if any
    promptQueue: [],
    subagents: 0,
    childAlive: true,
    busy: false,
    expandTools: false,
    showThinking: true,
    notice: undefined, // one transient footer line
    seq: 0,
  };
}

const pushBlock = (state, block) => ({ ...state, seq: state.seq + 1, blocks: [...state.blocks, { id: state.seq + 1, ...block }] });
const mapBlock = (state, predicate, update) => ({
  ...state,
  blocks: state.blocks.map((block) => (predicate(block) ? update(block) : block)),
});
const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "");

function parseArgs(raw) {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function foldUsage(state, usage) {
  if (!usage || typeof usage !== "object") return state;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(usage.inputTokens);
  const output = n(usage.outputTokens);
  const cacheRead = n(usage.cacheReadTokens);
  const cacheWrite = n(usage.cacheWriteTokens);
  const reported = Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : undefined;
  return {
    ...state,
    costReported: state.costReported || reported !== undefined,
    usage: {
      input: state.usage.input + input,
      output: state.usage.output + output,
      cacheRead: state.usage.cacheRead + cacheRead,
      cacheWrite: state.usage.cacheWrite + cacheWrite,
      requests: state.usage.requests + 1,
      cost: (state.usage.cost ?? 0) + (reported ?? requestCost(state.price, { input, output, cacheRead, cacheWrite })),
    },
    // Occupancy of the window after this request: everything sent plus what the model answered.
    contextTokens: input + cacheRead + cacheWrite + output,
  };
}

function afterTools(state, activeTools) {
  const live = Object.keys(activeTools).length > 0;
  if (state.hadError) return { ...state, activeTools };
  return { ...state, activeTools, phase: live ? "tool" : state.busy ? "thinking" : state.phase, detail: "" };
}

/** Tool cards still pending when a turn ends, is cancelled or the harness dies were interrupted, not successful. */
function settlePending(state, reason = "interrupted") {
  if (!state.blocks.some((b) => b.kind === "tool" && b.status === "pending")) return state;
  return mapBlock(state, (b) => b.kind === "tool" && b.status === "pending", (b) => ({ ...b, status: "error", result: "", error: { name: "Interrupted", code: "INTERRUPTED", reason } }));
}

function turnEnd(state, reason) {
  return turnEnd0(settlePending(state), reason);
}

function turnEnd0(state, reason) {
  const kind = reason?.kind;
  const base = { ...state, busy: false, activeTools: {} };
  // A tool that failed mid-turn is not a failed turn: the model saw the error and went on. Only a turn error sticks.
  if (kind === "completed") return { ...base, phase: "complete", detail: "", hadError: false };
  if (kind === "aborted") return { ...base, phase: "stopped", detail: oneLine(typeof reason.reason === "string" ? reason.reason : reason.reason?.kind ?? "cancelled") };
  if (kind === "error") {
    const message = oneLine(reason.error?.message ?? reason.error?.code ?? "model error");
    return pushBlock({ ...base, phase: "error", detail: truncatePlain(message, 60), hadError: true }, { kind: "error", text: message });
  }
  if (kind === "max-tokens") return { ...base, phase: "stopped", detail: "max tokens" };
  if (kind === "blocked") return { ...base, phase: "stopped", detail: "blocked" };
  return { ...base, phase: "complete", detail: "" };
}

/**
 * The SDK wire wraps an event's fields in `data` ({ type, seq, time, data: { turn, callId, ... } }). Lift them to
 * the top level so every reader sees one shape; an event that is already flat is returned unchanged.
 */
export function flattenEvent(event) {
  const data = event?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return event;
  return { ...data, type: event.type };
}

function onSessionEvent(state, wireEvent) {
  const event = flattenEvent(wireEvent);
  switch (event?.type) {
    case "turn/start":
      return { ...state, phase: "thinking", detail: "", hadError: false, busy: true, activeTools: {} };
    case "step/start":
      return { ...state, busy: true, phase: state.hadError ? "error" : Object.keys(state.activeTools).length ? "tool" : "thinking", detail: "" };
    case "request/context":
      return Number.isFinite(event.contextWindow) ? { ...state, contextWindow: event.contextWindow } : state;
    case "assistant/message": {
      let next = foldUsage(state, event.usage);
      const content = event.message?.content ?? [];
      let responded = false;
      for (const block of content) {
        if (block?.type === "reasoning" && typeof block.text === "string" && block.text.trim()) {
          next = pushBlock(next, { kind: "thinking", text: block.text });
        } else if (block?.type === "text" && block.text.trim()) {
          next = pushBlock(next, { kind: "assistant", text: block.text });
          responded = true;
        }
      }
      if (event.interrupted) {
        next = pushBlock(next, { kind: "notice", text: "interrupted: the reply above is the part delivered before the stop" });
        return { ...next, phase: "stopped", detail: "interrupted" };
      }
      return responded && !next.hadError ? { ...next, phase: "responding", detail: "" } : next;
    }
    case "tool/call": {
      const args = parseArgs(event.arguments);
      const next = pushBlock(state, { kind: "tool", callId: event.callId, name: event.name, args, status: "pending" });
      const activeTools = { ...next.activeTools, [event.callId]: event.name };
      return { ...next, activeTools, busy: true, phase: next.hadError ? "error" : "tool", detail: next.hadError ? next.detail : "" };
    }
    case "tool/result": {
      const callId = event.message?.toolCallId;
      const failed = event.message?.isError === true || event.error !== undefined;
      const name = state.activeTools[callId] ?? "tool";
      let next = mapBlock(state, (b) => b.kind === "tool" && b.callId === callId, (b) => ({
        ...b,
        status: failed ? "error" : "success",
        result: textOf(event.message?.content),
        error: event.error,
        meta: event.meta,
      }));
      const activeTools = { ...next.activeTools };
      delete activeTools[callId];
      if (failed) next = { ...next, hadError: true, phase: "error", detail: name, activeTools };
      else next = afterTools(next, activeTools);
      return next;
    }
    case "turn/end":
      return turnEnd(state, event.reason);
    default:
      return state;
  }
}

function openPrompt(state, prompt) {
  if (state.prompt) return { ...state, promptQueue: [...state.promptQueue, prompt] };
  return { ...state, prompt, phase: "waiting", detail: prompt.title };
}

function closePrompt(state) {
  const [nextPrompt, ...rest] = state.promptQueue;
  if (nextPrompt) return { ...state, prompt: nextPrompt, promptQueue: rest, phase: "waiting", detail: nextPrompt.title };
  const phase = state.hadError ? "error" : Object.keys(state.activeTools).length ? "tool" : state.busy ? "thinking" : "ready";
  return { ...state, prompt: undefined, promptQueue: [], phase, detail: phase === "error" ? state.detail : "" };
}

export function reduce(state, action) {
  switch (action.type) {
    case "init":
      return { ...state, model: action.model ?? state.model, effort: action.effort ?? state.effort, sessionId: action.sessionId ?? state.sessionId, childAlive: true };
    case "ready":
      return { ...state, childAlive: true, phase: "ready", detail: action.detail ?? "ready", hadError: false, busy: false, activeTools: {} };
    case "restarted":
      return { ...state, childAlive: true };
    case "submit":
      return { ...pushBlock(state, { kind: "user", text: action.text }), phase: "thinking", detail: "", hadError: false, busy: true };
    case "command": // a slash command sent through session/query
      return { ...pushBlock(state, { kind: "user", text: action.text }), phase: action.compact ? "compacting" : "thinking", detail: "", hadError: false, busy: true };
    case "queryCompleted":
      return { ...(action.text ? pushBlock(state, { kind: "notice", text: action.text }) : state), busy: false, phase: state.hadError ? "error" : "ready", detail: state.hadError ? state.detail : action.detail ?? "" };
    case "notification": {
      const { method, params } = action;
      if (method === "session.event") {
        if (params?.sessionId !== state.sessionId) return state;
        return onSessionEvent(state, params.event);
      }
      if (method === "session.status") {
        if (params?.sessionId !== state.sessionId) return state;
        if (params.status === "running") return state.busy ? state : { ...state, busy: true, phase: state.hadError ? "error" : "thinking", detail: "" };
        // idle: a turn/end already chose the terminal phase; anything still "live" settles to ready.
        const live = ["thinking", "responding", "tool", "compacting"].includes(state.phase);
        return { ...state, busy: false, activeTools: {}, phase: live ? "ready" : state.phase, detail: live ? "" : state.detail };
      }
      if (method === "subagent.started") return { ...state, subagents: state.subagents + 1 };
      if (method === "subagent.finished") return { ...state, subagents: Math.max(0, state.subagents - 1) };
      if (method === "session.query.completed") return params?.sessionId === state.sessionId ? reduce(state, { type: "queryCompleted", text: typeof params.finalResponse === "string" ? params.finalResponse.trim() : "" }) : state;
      return state;
    }
    case "prompt":
      return openPrompt(state, action.prompt);
    case "promptUpdate":
      return { ...state, prompt: action.prompt };
    case "promptDone":
      return closePrompt(state);
    case "cancelRequested":
      return { ...state, detail: "cancelling" };
    case "cancelled":
      return {
        ...pushBlock(settlePending({ ...state, prompt: undefined, promptQueue: [] }), { kind: "notice", text: "turn cancelled; the harness was restarted and the session resumed" }),
        phase: "stopped", detail: "cancelled", busy: false, activeTools: {}, hadError: false,
      };
    case "childExit": {
      const why = oneLine(action.reason ?? "harness exited");
      return pushBlock(settlePending({ ...state, childAlive: false, prompt: undefined, promptQueue: [], busy: false, activeTools: {}, phase: "error", detail: "harness exited", hadError: true }), { kind: "error", text: `${why}: pending approvals and questions were refused. Send a message to restart the harness and resume the session.` });
    }
    case "error":
      return pushBlock({ ...state, phase: "error", detail: truncatePlain(action.message, 60), hadError: true, busy: false }, { kind: "error", text: oneLine(action.message) });
    case "notice":
      return pushBlock(state, { kind: "notice", text: action.text });
    case "footer":
      return { ...state, notice: action.text || undefined };
    case "newSession":
      return { ...initialState({ model: state.model, effort: state.effort, sessionId: action.sessionId, cwd: state.cwd, contextWindow: state.contextWindow, price: state.price }), expandTools: state.expandTools, showThinking: state.showThinking };
    case "toggleTools":
      return { ...state, expandTools: !state.expandTools };
    case "toggleThinking":
      return { ...state, showThinking: !state.showThinking };
    default:
      return state;
  }
}

/** The status text and tone for the band, in the Steak Pi vocabulary. */
export function statusPresentation(state) {
  const tools = Object.values(state.activeTools);
  switch (state.phase) {
    case "ready": return { text: state.detail ? `● ${state.detail}` : "● ready", tone: "dim" };
    case "thinking": return { text: state.detail ? `◆ ${state.detail}` : "◆ thinking", tone: "accent" };
    case "responding": return { text: "◆ responding", tone: "accent" };
    case "tool": return { text: tools.length > 1 ? `◆ tools ${tools.length}` : `◆ tool ${tools[0] ?? "running"}`, tone: "accent" };
    case "waiting": return { text: state.detail ? `◇ waiting · ${state.detail}` : "◇ waiting", tone: "warning" };
    case "compacting": return { text: "◆ compacting", tone: "warning" };
    case "complete": return { text: "✓ complete", tone: "success" };
    case "error": return { text: state.detail ? `! error · ${state.detail}` : "! error", tone: "error" };
    case "stopped": return { text: state.detail ? `! stopped · ${state.detail}` : "! stopped", tone: "warning" };
    default: return { text: "● ready", tone: "dim" };
  }
}
