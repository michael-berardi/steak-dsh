/**
 * Transcript rendering: state.blocks -> painted lines, each at most `width` columns.
 * User messages and tool cards sit on raised background slabs; thinking renders dim; assistant text goes through
 * the minimal Markdown pass; tool results preview 10 lines with a "... (N more lines, ctrl+o to expand)" tail.
 */
import { shortArgs } from "../render.js";
import { renderHunk } from "./diff.js";
import { renderMarkdown } from "./markdown.js";
import { TOOL_PREVIEW_LINES } from "./state.js";
import { fitLine, padAnsi, visibleWidth, wrapPlain } from "./width.js";

/** A background slab: every line padded to `width`, one column of padding each side. */
function slab(lines, width, token, theme) {
  const inner = width - 2;
  return lines.map((line) => theme.bg(token, " " + padAnsi(line, inner) + " "));
}

function userLines(block, width, theme) {
  const body = wrapPlain(block.text, width - 2).map((l) => l.trimEnd());
  return slab(body.length ? body : [""], width, "userMessageBg", theme);
}

function thinkingLines(block, width, state, theme) {
  const lines = block.text.trim().split("\n");
  if (!state.showThinking) return [theme.dim(fitLine(` ⋯ thinking (${lines.length} line${lines.length === 1 ? "" : "s"}) · ctrl+t to show`, width))];
  const painted = wrapPlain(block.text.trim(), width - 2).map((l) => " " + theme.italic(theme.fg("thinkingText", l.trimEnd())));
  return painted;
}

function toolHeader(block, width, theme) {
  const glyph = block.status === "pending" ? theme.accent("◆") : block.status === "success" ? theme.success("✓") : theme.error("!");
  const name = theme.bold(theme.fg("toolTitle", block.name));
  const args = shortArgs(block.args);
  const used = 2 + visibleWidth(block.name) + 1;
  return `${glyph} ${name}${args ? " " + theme.muted(fitLine(args, Math.max(1, width - 2 - used))) : ""}`;
}

function resultLines(block, inner, state, theme) {
  const out = [];
  const hunks = block.meta?.diffs;
  if (block.status !== "error" && Array.isArray(hunks) && hunks.length > 0) {
    hunks.forEach((hunk, index) => {
      const where = hunk.newStart === undefined ? " (line numbers relative to the hunk)" : "";
      out.push(theme.muted(fitLine(`${hunk.path}${hunks.length > 1 ? ` · hunk ${index + 1}/${hunks.length}` : ""}${where}`, inner)));
      out.push(...renderHunk(hunk, inner, theme));
    });
    return out;
  }
  const text = (block.result ?? "").replace(/\s+$/, "");
  if (block.status === "error") {
    const reason = block.error?.reason ?? text;
    const code = block.error?.code;
    const message = code && reason && code.toLowerCase() !== String(reason).toLowerCase() ? `${code}: ${reason}` : reason || code || "";
    for (const l of wrapPlain(message.trim(), inner)) out.push(theme.error(l.trimEnd()));
    return out.slice(0, state.expandTools ? Infinity : TOOL_PREVIEW_LINES);
  }
  if (!text) return out;
  const all = text.split("\n");
  const shown = state.expandTools ? all : all.slice(0, TOOL_PREVIEW_LINES);
  for (const l of shown) out.push(theme.muted(fitLine(l, inner)));
  if (all.length > shown.length) out.push(theme.muted(`... (${all.length - shown.length} more line${all.length - shown.length === 1 ? "" : "s"}, ctrl+o to expand)`));
  return out;
}

function toolLines(block, width, state, theme) {
  const inner = width - 2;
  const body = [toolHeader(block, width, theme), ...(block.status === "pending" ? [] : resultLines(block, inner, state, theme))];
  const token = block.status === "pending" ? "toolPendingBg" : block.status === "success" ? "toolSuccessBg" : "toolErrorBg";
  return slab(body, width, token, theme);
}

export function blockLines(block, width, state, theme) {
  switch (block.kind) {
    case "user": return userLines(block, width, theme);
    case "assistant": return renderMarkdown(block.text, width - 2, theme).map((l) => (l === "" ? "" : " " + l));
    case "thinking": return thinkingLines(block, width, state, theme);
    case "tool": return toolLines(block, width, state, theme);
    case "error": return wrapPlain(block.text, width - 4).map((l, i) => theme.error((i === 0 ? " ! " : "   ") + l.trimEnd()));
    case "notice": return wrapPlain(block.text, width - 4).map((l, i) => theme.dim((i === 0 ? " · " : "   ") + l.trimEnd()));
    default: return [];
  }
}

/** All transcript lines, with one blank line between blocks. */
export function renderTranscript(state, width, theme) {
  const lines = [];
  state.blocks.forEach((block, index) => {
    const previous = state.blocks[index - 1];
    // Consecutive tool cards sit flush; every other block change gets a blank line.
    if (index > 0 && !(previous.kind === "tool" && block.kind === "tool")) lines.push("");
    lines.push(...blockLines(block, width, state, theme));
  });
  return lines;
}
