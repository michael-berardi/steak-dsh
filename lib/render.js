/**
 * Pure renderer for the dsh headless --json event stream (chat mode).
 * Assistant text plain; each tool call one dim line `> tool: short args`; errors red;
 * a closing dim line with turns and tokens. Colour is opt-in via { color: true }.
 */

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const paint = (text, code, color) => (color ? code + text + RESET : text);
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
const oneLine = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return String(text).replace(/\s+/g, " ").trim();
};

/** One short representative argument for a tool-call line. */
export function shortArgs(input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return clip(oneLine(input), 80);
  if (typeof input !== "object") return clip(String(input), 80);
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "prompt", "task"]) {
    if (typeof input[key] === "string") return clip(oneLine(input[key]), 80);
  }
  const first = Object.values(input).find((value) => typeof value === "string");
  return clip(first === undefined ? oneLine(input) : oneLine(first), 80);
}

/** Lines to print for one event as it arrives (may be empty). Never mutates the event. */
export function renderEvent(event, { color = false } = {}) {
  switch (event?.type) {
    case "text":
      return typeof event.text === "string" && event.text.length > 0 ? [event.text] : [];
    case "tool_call":
      return [paint(`> ${event.tool}: ${shortArgs(event.input)}`, DIM, color)];
    case "tool_result":
      return event.status === "error" ? [paint(`! ${clip(oneLine(event.result), 200)}`, RED, color)] : [];
    case "error":
      return [paint(`error: ${oneLine(event.message ?? "unknown error")}`, RED, color)];
    default:
      return [];
  }
}

/** Fold turn/token counters from one event into `totals` ({ turns, tokens }). */
export function countEvent(totals, event) {
  if (event?.type !== "status") return totals;
  if (event.phase === "turn_end") totals.turns += 1;
  if (event.phase === "step_end" && event.usage) {
    totals.tokens += event.usage.totalTokens ?? ((event.usage.inputTokens ?? 0) + (event.usage.outputTokens ?? 0));
  }
  return totals;
}

/** The closing dim line. */
export function summaryLine(totals, { color = false } = {}) {
  return paint(`— ${totals.turns} turn${totals.turns === 1 ? "" : "s"}, ${totals.tokens} tokens`, DIM, color);
}

/** Render a whole canned event list: per-event lines plus the closing summary. Pure. */
export function render(events, { color = false } = {}) {
  const lines = [];
  const totals = { turns: 0, tokens: 0 };
  for (const event of events) {
    lines.push(...renderEvent(event, { color }));
    countEvent(totals, event);
  }
  lines.push(summaryLine(totals, { color }));
  return lines;
}
