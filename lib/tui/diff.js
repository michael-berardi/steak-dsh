/**
 * Numbered, coloured diffs. A tool result's presentation `meta.diffs` is a list of hunks { path, oldText|null, newText }
 * (each already carries a few lines of context). Lines render `-N text` / `+N text` / ` N text`; removed lines come
 * before added lines in a change group; a group of exactly one removed and one added line gets a word-level
 * highlight (inverse video) on the changed words.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fitLine, visibleWidth } from "./width.js";

const MAX_LCS_CELLS = 250_000;

/** LCS-based line diff of two arrays -> ops [{ t: "ctx"|"del"|"add", text }]. */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = a.slice(0, start).map((text) => ({ t: "ctx", text }));
  const mid = lcsOps(a.slice(start, endA), b.slice(start, endB));
  ops.push(...mid, ...a.slice(endA).map((text) => ({ t: "ctx", text })));
  return ops;
}

function lcsOps(a, b) {
  if (a.length === 0) return b.map((text) => ({ t: "add", text }));
  if (b.length === 0) return a.map((text) => ({ t: "del", text }));
  if (a.length * b.length > MAX_LCS_CELLS) return [...a.map((text) => ({ t: "del", text })), ...b.map((text) => ({ t: "add", text }))];
  const m = a.length;
  const n = b.length;
  const table = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  const dels = [];
  const adds = [];
  const settle = () => { ops.push(...dels.splice(0).map((text) => ({ t: "del", text })), ...adds.splice(0).map((text) => ({ t: "add", text }))); };
  while (i < m && j < n) {
    if (a[i] === b[j]) { settle(); ops.push({ t: "ctx", text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) dels.push(a[i++]);
    else adds.push(b[j++]);
  }
  while (i < m) dels.push(a[i++]);
  while (j < n) adds.push(b[j++]);
  settle();
  return ops;
}

/** Tokens for a word diff: runs of word characters, runs of whitespace, single other characters. */
const tokens = (line) => line.match(/\s+|\w+|[^\s\w]/gu) ?? [];

/** Mark the changed tokens of a 1:1 pair. Returns [oldSpans, newSpans] with { text, changed }. */
export function wordDiff(oldLine, newLine) {
  const ops = diffLines(tokens(oldLine), tokens(newLine));
  const oldSpans = [];
  const newSpans = [];
  const push = (list, text, changed) => {
    const last = list.at(-1);
    if (last && last.changed === changed) last.text += text;
    else list.push({ text, changed });
  };
  for (const op of ops) {
    if (op.t === "ctx") { push(oldSpans, op.text, false); push(newSpans, op.text, false); }
    else if (op.t === "del") push(oldSpans, op.text, !/^\s+$/.test(op.text));
    else push(newSpans, op.text, !/^\s+$/.test(op.text));
  }
  return [oldSpans, newSpans];
}

/**
 * Find where each hunk sits in the file's current text. Returns hunks with oldStart/newStart (1-based) or
 * `undefined` for a hunk that cannot be located (numbers are then relative to the hunk).
 */
export function locateHunks(diffs, fileText) {
  let delta = 0;
  let searchFrom = 0;
  return diffs.map((hunk) => {
    const oldLines = hunk.oldText === null ? [] : hunk.oldText.split("\n");
    const newLines = hunk.newText.split("\n");
    const at = newLines.length === 0 || (newLines.length === 1 && newLines[0] === "") ? -1 : fileText.indexOf(hunk.newText, searchFrom);
    if (at < 0) return { ...hunk };
    searchFrom = at + hunk.newText.length;
    const newStart = fileText.slice(0, at).split("\n").length;
    const located = { ...hunk, newStart, oldStart: newStart - delta };
    delta += newLines.length - oldLines.length;
    return located;
  });
}

/** Attach line positions to `meta.diffs` by reading the edited file. Never throws; a miss leaves hunks relative. */
export function enrichMeta(meta, cwd, read = (path) => (statSync(path).size <= 2_000_000 ? readFileSync(path, "utf8") : undefined)) {
  const diffs = meta?.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0) return meta;
  const byPath = new Map();
  for (const hunk of diffs) {
    if (typeof hunk?.path !== "string") return meta;
    if (!byPath.has(hunk.path)) byPath.set(hunk.path, []);
    byPath.get(hunk.path).push(hunk);
  }
  const located = new Map();
  for (const [path, hunks] of byPath) {
    let text;
    try { text = read(isAbsolute(path) ? path : resolve(cwd || ".", path)); } catch { text = undefined; }
    located.set(path, text === undefined ? hunks : locateHunks(hunks, text.replace(/\r\n/g, "\n")));
  }
  const counters = new Map();
  return { ...meta, diffs: diffs.map((hunk) => { const i = counters.get(hunk.path) ?? 0; counters.set(hunk.path, i + 1); return located.get(hunk.path)[i]; }) };
}

/** Render one hunk to painted lines of at most `width` columns. */
export function renderHunk(hunk, width, theme) {
  const oldLines = hunk.oldText === null ? [] : hunk.oldText.split("\n");
  const newLines = hunk.newText.split("\n");
  const ops = diffLines(oldLines, newLines);
  let oldNo = hunk.oldStart ?? 1;
  let newNo = hunk.newStart ?? 1;
  const last = Math.max(oldNo + oldLines.length, newNo + newLines.length);
  const digits = String(last).length;
  const textWidth = Math.max(1, width - digits - 2);
  const out = [];
  const num = (n) => String(n).padStart(digits, " ");
  const paint = (op, no, sign, token, spans) => {
    const gutter = theme.fg(token, `${sign}${num(no)} `);
    if (!spans) return gutter + theme.fg(token, fitLine(op.text, textWidth));
    let remaining = textWidth;
    let body = "";
    for (const span of spans) {
      if (remaining <= 0) break;
      const piece = visibleWidth(span.text) > remaining ? fitLine(span.text, remaining) : span.text;
      remaining -= visibleWidth(piece);
      body += span.changed ? theme.inverse(theme.fg(token, piece)) : theme.fg(token, piece);
    }
    return gutter + body;
  };
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === "ctx") { out.push(theme.fg("toolDiffContext", ` ${num(newNo)} ${fitLine(ops[i].text, textWidth)}`)); oldNo++; newNo++; i++; continue; }
    const dels = [];
    const adds = [];
    while (i < ops.length && ops[i].t !== "ctx") { (ops[i].t === "del" ? dels : adds).push(ops[i]); i++; }
    const pair = dels.length === 1 && adds.length === 1 && theme.color ? wordDiff(dels[0].text.replace(/^\s+/, ""), adds[0].text.replace(/^\s+/, "")) : undefined;
    const lead = (op) => op.text.match(/^\s*/)[0];
    const withLead = (op, spans) => (spans ? [{ text: lead(op), changed: false }, ...spans] : undefined);
    dels.forEach((op, k) => out.push(paint(op, oldNo + k, "-", "toolDiffRemoved", pair ? withLead(op, pair[0]) : undefined)));
    adds.forEach((op, k) => out.push(paint(op, newNo + k, "+", "toolDiffAdded", pair ? withLead(op, pair[1]) : undefined)));
    oldNo += dels.length;
    newNo += adds.length;
  }
  return out;
}
