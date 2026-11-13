/**
 * Frame composition: regions top to bottom, anchored to the bottom of the terminal.
 *
 *   top margin (0-1)        one blank row, so the header is not on the terminal's first row
 *   header (1)              🥩  STEAK DSH ........ hints
 *   header gap (0-1)        one blank row between the header and the transcript
 *   transcript viewport     messages, thinking, tool cards, diffs (PageUp/PageDown scroll); empty on an empty session
 *   pinned row (0-1)        subagent count
 *   prompt overlay (0-n)    approval / question selector
 *   status band (1-3)       identity, context meter, metrics
 *   editor (1-6)            ╰─ gutter, "Message" placeholder
 *   footer (0-1)            one transient notice
 *
 * The two margin rows (top margin, header gap) are kept when the terminal has at least ROOMY_MIN_ROWS (12) rows and
 * dropped below that, which keeps the compact layout (header on row 0, transcript directly under it) on small panes.
 *
 * composeFrame is pure: (state, ui, size, theme) -> { lines, cursor }. Every line fits the width.
 */
import { renderBand, renderHeader } from "./band.js";
import { renderPrompt } from "./prompt.js";
import { renderTranscript } from "./transcript.js";
import { clipAnsi, fitLine, visibleWidth } from "./width.js";

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_MS = 80;
/** Terminals with fewer rows than this get the compact layout (no blank rows around the header). */
export const ROOMY_MIN_ROWS = 12;

const WORKING = { thinking: "thinking", responding: "responding", tool: "running tool", compacting: "compacting", waiting: "waiting for input" };

function workingLine(state, ui, theme, width) {
  if (!state.busy || state.prompt) return undefined;
  const label = state.phase === "tool" && Object.keys(state.activeTools).length > 1 ? "running tools" : WORKING[state.phase] ?? "working";
  return " " + theme.accent(SPINNER[(ui.spinner ?? 0) % SPINNER.length]) + " " + theme.muted(fitLine(`${label} (esc to interrupt)`, Math.max(1, width - 3)));
}

export function composeFrame(state, ui, size, theme) {
  const width = Math.max(1, size.columns);
  const height = Math.max(1, size.rows);
  const roomy = height >= ROOMY_MIN_ROWS;
  const top = roomy ? [""] : [];
  const header = [renderHeader(width, theme)];
  const gap = roomy ? [""] : [];
  const band = renderBand(width, state, theme);
  const pinned = state.subagents > 0 ? [" " + theme.accent("◇ ") + theme.muted(`${state.subagents} subagent${state.subagents === 1 ? "" : "s"} running`)] : [];
  const prompt = state.prompt ? renderPrompt(state.prompt, width, theme) : [];
  const footer = state.notice ? [theme.dim(fitLine(state.notice, width))] : [];

  // The editor gets what the viewport can spare: at least 1 row, at most 6.
  const fixed = top.length + header.length + gap.length + band.length + pinned.length + prompt.length + footer.length;
  const editorBudget = Math.max(1, Math.min(6, height - fixed - 1));
  const editor = ui.editor.render(width, theme, { maxRows: editorBudget });
  const viewport = Math.max(0, height - fixed - editor.lines.length);

  let body = state.blocks.length === 0 ? [] : renderTranscript(state, width, theme);
  const working = workingLine(state, ui, theme, width);
  if (working) body = [...body, "", working];
  const scroll = Math.max(0, Math.min(ui.scroll ?? 0, Math.max(0, body.length - viewport)));
  const end = body.length - scroll;
  let shown = body.slice(Math.max(0, end - viewport), end);
  if (scroll > 0 && shown.length > 0) shown[shown.length - 1] = theme.dim(fitLine(`↓ ${scroll} more line${scroll === 1 ? "" : "s"} · pagedown`, width));
  const blanks = Array.from({ length: Math.max(0, viewport - shown.length) }, () => "");
  shown = [...shown, ...blanks];

  const lines = [...top, ...header, ...gap, ...shown, ...pinned, ...prompt, ...band, ...editor.lines, ...footer].map((l) => (visibleWidth(l) > width ? clipAnsi(l, width) : l));
  const editorTop = top.length + header.length + gap.length + shown.length + pinned.length + prompt.length + band.length;
  const cursor = state.prompt ? undefined : { row: editorTop + editor.cursor.row, col: Math.min(width - 1, editor.cursor.col) };
  // When the regions overflow a very small terminal the top rows are cut, and the cursor row moves up with them.
  const cut = Math.max(0, lines.length - height);
  if (cursor) cursor.row = Math.max(0, cursor.row - cut);
  return { lines: lines.slice(-height), cursor };
}

/** Plain-text view of a frame (what a golden file holds): ANSI stripped, trailing spaces trimmed. */
export function frameText(frame, strip) {
  return frame.lines.map((l) => strip(l).replace(/\s+$/, "")).join("\n") + "\n";
}
