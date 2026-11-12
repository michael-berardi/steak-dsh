/**
 * Approval and user-question prompts: pure state machines plus their rendering.
 * `promptKey(prompt, event)` returns { prompt } to keep going or { result } when the prompt settles.
 * A result is the exact JSON the harness expects as the RPC response, so the controller only forwards it.
 * Failing closed is the controller's rule (child death drops every prompt without allowing anything); here the
 * safe defaults are: Escape and "n" reject, the first row is never auto-selected by a stray key.
 */
import { fitLine, padAnsi, visibleWidth, wrapPlain } from "./width.js";

export function approvalPrompt(params, rpcId) {
  const toolName = String(params?.toolName ?? "tool");
  return {
    kind: "approval", rpcId, sessionId: params?.sessionId, callId: params?.callId, toolName,
    reason: typeof params?.reason === "string" ? params.reason : "",
    title: toolName, index: 0,
    options: [{ label: "Allow once", outcome: "allowed-once" }, { label: "Reject", outcome: "rejected" }],
  };
}

function optionsFor(question) {
  if (Array.isArray(question.options) && question.options.length > 0) return question.options.map((o) => ({ label: String(o.label), description: o.description }));
  const intent = question.intent;
  if (intent?.kind === "approval") return [{ label: intent.approve }, { label: intent.reject }];
  if (intent?.kind === "plan-review") return [{ label: intent.approve }];
  return [];
}

export function questionPrompt(params, rpcId) {
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  return {
    kind: "question", rpcId, requestId: params?.requestId, sessionId: params?.sessionId, questions,
    title: String(questions[0]?.header ?? questions[0]?.question ?? "question").slice(0, 40),
    qi: 0, index: 0, picked: [], answers: [], typing: undefined, error: "",
  };
}

const rowsOf = (prompt) => {
  if (prompt.kind === "approval") return prompt.options;
  const q = prompt.questions[prompt.qi];
  const options = optionsFor(q);
  return options.length > 0 ? [...options, { label: "Other…", other: true }] : [];
};

const cancelled = { cancelled: true };

function finishQuestion(prompt, item) {
  const answers = [...prompt.answers, item];
  if (prompt.qi + 1 >= prompt.questions.length) return { result: { answers } };
  return { prompt: { ...prompt, qi: prompt.qi + 1, index: 0, picked: [], answers, typing: undefined, error: "" } };
}

export function promptKey(prompt, event) {
  if (prompt.kind === "approval") return approvalKey(prompt, event);
  return questionKey(prompt, event);
}

function approvalKey(prompt, event) {
  const outcome = (o) => ({ result: { outcome: o } });
  if (event.type === "key") {
    if (event.name === "escape" || (event.ctrl && event.name === "c")) return outcome("rejected");
    if (event.name === "up") return { prompt: { ...prompt, index: (prompt.index + prompt.options.length - 1) % prompt.options.length } };
    if (event.name === "down" || event.name === "tab") return { prompt: { ...prompt, index: (prompt.index + 1) % prompt.options.length } };
    if (event.name === "enter") return outcome(prompt.options[prompt.index].outcome);
  } else if (event.type === "text") {
    const t = event.text.toLowerCase();
    if (t === "y") return outcome("allowed-once");
    if (t === "n") return outcome("rejected");
  }
  return { prompt };
}

function questionKey(prompt, event) {
  const q = prompt.questions[prompt.qi];
  if (!q) return { result: cancelled };
  if (prompt.typing !== undefined) {
    if (event.type === "key" && event.name === "escape") return { prompt: { ...prompt, typing: undefined } };
    if (event.type === "key" && event.name === "enter") {
      const custom = prompt.typing.trim();
      if (!custom) return { prompt: { ...prompt, error: "type an answer or press Esc to go back" } };
      return finishQuestion(prompt, { id: q.id, selected: [...prompt.picked], custom });
    }
    if (event.type === "key" && event.name === "backspace") return { prompt: { ...prompt, typing: Array.from(prompt.typing).slice(0, -1).join(""), error: "" } };
    if (event.type === "text" || event.type === "paste") return { prompt: { ...prompt, typing: prompt.typing + event.text.replace(/[\r\n]+/g, " "), error: "" } };
    return { prompt };
  }
  const rows = rowsOf(prompt);
  if (event.type === "key" && (event.name === "escape" || (event.ctrl && event.name === "c"))) return { result: cancelled };
  if (rows.length === 0) { // free-text question
    if (event.type === "key" && event.name === "enter") return { prompt: { ...prompt, typing: "" } };
    if (event.type === "text") return { prompt: { ...prompt, typing: event.text } };
    return { prompt };
  }
  if (event.type === "key" && event.name === "up") return { prompt: { ...prompt, index: (prompt.index + rows.length - 1) % rows.length } };
  if (event.type === "key" && (event.name === "down" || event.name === "tab")) return { prompt: { ...prompt, index: (prompt.index + 1) % rows.length } };
  const row = rows[prompt.index];
  if (q.multiSelect && event.type === "text" && event.text === " " && !row.other) {
    const picked = prompt.picked.includes(row.label) ? prompt.picked.filter((l) => l !== row.label) : [...prompt.picked, row.label];
    return { prompt: { ...prompt, picked, error: "" } };
  }
  if (event.type === "key" && event.name === "enter") {
    if (row.other) return { prompt: { ...prompt, typing: "", error: "" } };
    if (q.multiSelect) {
      const picked = prompt.picked.includes(row.label) ? prompt.picked : [...prompt.picked, row.label];
      return finishQuestion(prompt, { id: q.id, selected: picked });
    }
    return finishQuestion(prompt, { id: q.id, selected: [row.label] });
  }
  return { prompt };
}

/** The settled prompt text for a transcript notice. */
export function describeResult(prompt, result) {
  if (prompt.kind === "approval") return `${result.outcome === "allowed-once" ? "allowed once" : result.outcome === "rejected" ? "rejected" : "cancelled"}: ${prompt.toolName}`;
  if (result.cancelled) return "question dismissed";
  return `answered: ${result.answers.map((a) => [...a.selected, a.custom].filter(Boolean).join(", ")).join(" | ")}`;
}

/** Painted lines for the prompt overlay, `width` columns wide. */
export function renderPrompt(prompt, width, theme) {
  const out = [];
  const rule = (label) => {
    const text = ` ${label} `;
    const fill = Math.max(0, width - 2 - visibleWidth(text));
    return theme.dim("─") + theme.warning(theme.bold(fitLine(text, width - 3))) + theme.dim("─".repeat(Math.max(0, fill)));
  };
  const row = (label, selected, mark) => {
    const line = `${selected ? "›" : " "} ${mark}${label}`;
    return selected ? theme.bg("selectedBg", padAnsi(theme.accent(fitLine(line, width)), width)) : fitLine(line, width);
  };
  if (prompt.kind === "approval") {
    out.push(rule(`confirm · ${prompt.toolName}`));
    if (prompt.reason) out.push(...wrapPlain(prompt.reason, width - 2).map((l) => " " + theme.muted(l.trimEnd())));
    prompt.options.forEach((o, i) => out.push(row(o.label, i === prompt.index, "")));
    out.push(theme.dim(fitLine(" ↑↓ select · enter confirm · y allow once · n/esc reject", width)));
    return out;
  }
  const q = prompt.questions[prompt.qi];
  const progress = prompt.questions.length > 1 ? ` (${prompt.qi + 1}/${prompt.questions.length})` : "";
  out.push(rule(`${q.header ?? "question"}${progress}`));
  for (const l of wrapPlain(q.question ?? "", width - 2)) out.push(" " + theme.text(l.trimEnd()));
  if (q.detail) for (const l of wrapPlain(q.detail, width - 2)) out.push(" " + theme.muted(l.trimEnd()));
  if (prompt.typing !== undefined) {
    out.push(" " + theme.accent("› ") + prompt.typing + theme.inverse(" "));
    if (prompt.error) out.push(" " + theme.error(fitLine(prompt.error, width - 2)));
    out.push(theme.dim(fitLine(" type an answer · enter confirm · esc back", width)));
    return out;
  }
  const rows = rowsOf(prompt);
  rows.forEach((o, i) => {
    const mark = q.multiSelect && !o.other ? (prompt.picked.includes(o.label) ? "[x] " : "[ ] ") : "";
    out.push(row(o.label + (o.description ? ` · ${o.description}` : ""), i === prompt.index, mark));
  });
  out.push(theme.dim(fitLine(q.multiSelect ? " ↑↓ select · space toggle · enter confirm · esc dismiss" : " ↑↓ select · enter confirm · esc dismiss", width)));
  return out;
}
