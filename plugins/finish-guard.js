/**
 * Finish guard for DeepSeek Harness: a turn may not end while requested work is still open.
 *
 * Runs on `agent/turn-stopping`, the hook DSH offers before a completed turn closes. It keeps the turn open
 * (one steering message) when the todo list has unfinished items or the final reply reports unfinished work.
 * At most `maxPushes` times per turn, never for subagents unless asked (`subagents: true`), never when the user asked to stop.
 * No imports from the harness, so it loads from a bundle, a profile patch or a plain file path.
 */
import { randomUUID } from "node:crypto";

export const name = "steak-finish-guard";
export const inject = ["agents"];

export const MARK = "FINISH GUARD";
const DEFAULT_MESSAGE =
  "You are about to end the turn with requested work still open. Do not stop. Keep working until every item is done and verified. "
  + "Only a real external blocker may remain: then ask for exactly that one thing, with everything else finished.";
const SCAN_LIMIT = 32_000;
const EXTERNAL_BLOCKER = /\b(?:2fa|two[- ]factor|otp|verification code|credential|password|api key|token expired|log ?in|sign[- ]in|payment|billing|spend|legal|sign-?off|approval|consent|physical|hardware)\b/i;
const OPEN_WORK = [
  /\bstill (?:not done|open|to do|left|pending|failing|unfixed|unresolved|broken)\b/i,
  /\bnot (?:done|fixed|finished|resolved|shipped|verified) yet\b/i,
  /\b(?:haven'?t|have not|didn'?t|did not) (?:fixed|fix|finished|finish|done|shipped|ship|verified|verify)\b/i,
  /\b(?:remaining|open|outstanding|unfinished) (?:items|work|tasks|issues)\s*:/i,
  /\b(?:still (?:have|has|got)|there (?:is|are)(?: still)?|we have|i have)\s+(?:some |a few |several |\d+ )?(?:remaining|open|outstanding|unfinished) (?:items|work|tasks|issues)\b/i,
  /\bleft to do\b/i,
  /\bnext (?:step|i'?ll|i will)\b/i,
  /(?:^|\n)\W*next\W*:\W*(?:i'?ll|i will|i'?m)\b/i,
  /\b(?:i'?m|i am) (?:fixing|working on|finishing|building|adding|shipping) (?:it|that|this|them) now\b/i,
  /\bstill needs? (?:a |the |an )?(?:test|tests|build|release|fix|review|deploy|install|verification)\b/i,
  /\b(?:haven'?t|have not|didn'?t|did not) (?:published|publish|released|release|deployed|deploy|installed|install|built|build|tested|test|merged|merge|pushed|push)\b/i,
  /\bnot (?:published|released|deployed|installed|built|tested|merged|pushed) yet\b/i,
  /\bwhat'?s left\b/i,
  /\bnot yet (?:fixed|done|addressed)\b/i,
];
const USER_STOP = /^\s*(?:hold|stop|pause)\b|\b(?:just|only) answer\b|\b(?:don'?t|do not) (?:do|change|touch|make) anything\b|\b(?:don'?t|do not) make any (?:edits|changes)\b|\bno (?:more )?(?:changes|edits)\b|\bstop (?:here|now|please)\b|\bstop\s*[.!?]*\s*$/i;
const QUOTED = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]{0,200}"|“[^”\n]{0,200}”/g;
const DONE = new Set(["done", "completed", "dropped", "cancelled", "canceled"]);

export function openTodos(items) {
  return (items ?? []).filter((item) => {
    const status = String(item?.status ?? "").toLowerCase();
    if (DONE.has(status)) return false;
    return !(status === "blocked" && EXTERNAL_BLOCKER.test(String(item.reason ?? item.blockedReason ?? "")));
  });
}

export function openWorkPhrases(text) {
  if (!text) return [];
  const scan = (text.length > SCAN_LIMIT ? text.slice(-SCAN_LIMIT) : text).replace(QUOTED, " ");
  const found = [];
  for (const pattern of OPEN_WORK) {
    const match = pattern.exec(scan);
    if (match) found.push(match[0]);
  }
  return found;
}

/** Pure decision. `pushes` counts how often this turn was already kept open. */
export function finishVerdict({ todos, finalText, userText, pushes, maxPushes = 3, message = DEFAULT_MESSAGE }) {
  if (pushes >= maxPushes) return { block: false, reason: "push cap reached" };
  const open = openTodos(todos);
  const phrases = openWorkPhrases(finalText);
  if (!open.length && !phrases.length) return { block: false, reason: "nothing open" };
  if (USER_STOP.test(userText ?? "")) return { block: false, reason: "user asked to stop or only answer" };
  const lines = [`${MARK}: ${message}`];
  if (open.length) {
    lines.push("Open todo items:");
    for (const item of open) lines.push(`- [${item.status}] ${item.content}`);
  }
  if (phrases.length) lines.push(`Your reply reports unfinished work instead of doing it: ${phrases.map((p) => `"${p}"`).join(", ")}.`);
  return { block: true, reason: lines.join("\n") };
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "");

/** Walk the session log backwards through the current turn: final reply, the user's request, latest todo list. */
export function readTurn(session, turn) {
  let finalText, userText, todos;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (!event) continue;
    if (event.type === "assistant/message" && finalText === undefined) finalText = textOf(event.data?.message?.content);
    else if (event.type === "todo/write" && todos === undefined) todos = event.data?.todos;
    else if (event.type === "user/message" && event.data?.source?.kind === "user" && userText === undefined) userText = textOf(event.data.content);
    // The current turn's start is a hard boundary: never read a todo list or reply from an earlier turn.
    if (event.type === "turn/start" && event.data?.turn === turn) break;
    if (seq < session.seq - 4000) break; // bounded scan; a todo list older than this is treated as absent
  }
  return { finalText: finalText ?? "", userText: userText ?? "", todos: todos ?? [] };
}

/**
 * True for a session a subagent tool created. A delegated child reports to its parent, which checks the result, so
 * the guard leaves it alone unless the row sets `subagents: true`. Reads the session header the harness keeps.
 */
export function isSubagent(agent) {
  const header = agent?.session?.header ?? agent?.session?.meta;
  return header?.origin === "subagent" || (Number.isInteger(header?.delegationDepth) && header.delegationDepth > 0);
}

export function steeringMessage(text, summary) {
  const message = {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: name, form: "notice", summary: summary.slice(0, 120) },
    id: randomUUID(),
  };
  return Object.freeze(message);
}

export function apply(ctx, config = {}) {
  const off = ["0", "false", "off", "no"].includes(String(process.env.STEAK_DSH_FINISH_GUARD ?? "").trim().toLowerCase());
  if (config.enabled === false || off) return;
  const maxPushes = Number.isInteger(config.maxPushes) && config.maxPushes >= 0 ? Math.min(config.maxPushes, 20) : 3;
  const pushes = new WeakMap(); // agent -> { turn, count }
  ctx.on("agent/turn-stopping", ({ agent, turn, signal }) => {
    if (signal.aborted) return;
    if (config.subagents !== true && isSubagent(agent)) return;
    const state = pushes.get(agent);
    const count = state?.turn === turn ? state.count : 0;
    let facts;
    try {
      facts = readTurn(agent.session, turn);
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not read the session log: ${error?.message ?? error}`);
      return;
    }
    const verdict = finishVerdict({ ...facts, pushes: count, maxPushes, message: config.message });
    if (!verdict.block) return;
    pushes.set(agent, { turn, count: count + 1 });
    if (process.env.STEAK_DSH_DEBUG) process.stderr.write(`steak-dsh: finish guard push ${count + 1}/${maxPushes}\n`);
    agent.steer(steeringMessage(verdict.reason, `finish guard push ${count + 1}/${maxPushes}`));
  });
}
