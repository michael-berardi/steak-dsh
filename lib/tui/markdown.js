/**
 * A minimal Markdown pass: headings, bullets, numbered lists, block quotes, rules, fenced code,
 * and inline **bold**, *italic*, `code`, [text](url). Everything else is plain text. Output lines fit `width`.
 * No syntax highlighting (a dependency-free renderer cannot match Steak Pi's there).
 */
import { fitLine, graphemeWidth, graphemes, visibleWidth } from "./width.js";

/** Split one line of text into [{ text, style }] spans. Unclosed markers stay literal. */
export function inlineSpans(text) {
  const spans = [];
  let plain = "";
  const flush = () => { if (plain) { spans.push({ text: plain, style: "plain" }); plain = ""; } };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m;
    if ((m = /^`([^`]+)`/.exec(rest))) { flush(); spans.push({ text: m[1], style: "code" }); i += m[0].length; continue; }
    if ((m = /^\*\*([^*]+)\*\*/.exec(rest)) || (m = /^__([^_]+)__/.exec(rest))) { flush(); spans.push({ text: m[1], style: "bold" }); i += m[0].length; continue; }
    if ((m = /^\*([^*\s][^*]*)\*/.exec(rest)) && !/\s$/.test(m[1])) { flush(); spans.push({ text: m[1], style: "italic" }); i += m[0].length; continue; }
    if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) { flush(); spans.push({ text: m[1], style: "link" }); i += m[0].length; continue; }
    plain += text[i];
    i += 1;
  }
  flush();
  return spans;
}

function painterFor(style, theme, base) {
  switch (style) {
    case "bold": return (t) => theme.bold(base(t));
    case "italic": return (t) => theme.italic(base(t));
    case "code": return (t) => theme.fg("mdCode", t);
    case "link": return (t) => theme.underline(theme.fg("mdLink", t));
    default: return base;
  }
}

/**
 * Wrap styled spans to `width`. `first`/`rest` are already-painted prefixes (with plain widths firstW/restW).
 * Breaks at spaces; hard-breaks words longer than a line on a grapheme boundary.
 */
export function wrapSpans(spans, width, theme, { first = "", firstW = 0, rest = "", restW = 0, base = (t) => t } = {}) {
  const cells = [];
  for (const span of spans) for (const g of graphemes(span.text)) cells.push({ g, style: span.style });
  const lines = [];
  let cur = []; // cells of the current line
  let curW = 0;
  const prefix = () => (lines.length === 0 ? [first, firstW] : [rest, restW]);
  const paintCells = (list) => {
    let out = "";
    let i = 0;
    while (i < list.length) {
      let j = i;
      while (j < list.length && list[j].style === list[i].style) j++;
      out += painterFor(list[i].style, theme, base)(list.slice(i, j).map((c) => c.g).join(""));
      i = j;
    }
    return out;
  };
  const flush = () => {
    while (cur.length && cur.at(-1).g === " ") cur.pop();
    const [p] = prefix();
    lines.push(p + paintCells(cur));
    cur = [];
    curW = 0;
  };
  const avail = () => width - prefix()[1];
  let k = 0;
  while (k < cells.length) {
    const isSpace = cells[k].g === " ";
    let end = k;
    while (end < cells.length && (cells[end].g === " ") === isSpace) end++;
    const word = cells.slice(k, end);
    const w = word.reduce((n, c) => n + graphemeWidth(c.g), 0);
    k = end;
    if (isSpace) { if (cur.length) { cur.push(...word); curW += w; } continue; }
    if (curW + w > avail() && cur.length) flush();
    if (w <= avail()) { cur.push(...word); curW += w; continue; }
    for (const c of word) {
      const cw = graphemeWidth(c.g);
      if (curW + cw > avail()) flush();
      cur.push(c);
      curW += cw;
    }
  }
  if (cur.length || lines.length === 0) flush();
  return lines;
}

export function renderMarkdown(text, width, theme, { base } = {}) {
  const baseP = base ?? ((t) => t);
  const out = [];
  let fence; // { lang } while inside a fence
  const w = Math.max(4, width);
  for (const raw of String(text).replace(/\r\n?/g, "\n").replace(/\t/g, "   ").split("\n")) {
    const fenceMatch = /^\s*```\s*([\w+-]*)\s*$/.exec(raw);
    if (fenceMatch) {
      if (fence) { fence = undefined; continue; }
      fence = { lang: fenceMatch[1] };
      if (fence.lang) out.push(theme.dim(fitLine(`╭ ${fence.lang}`, w)));
      continue;
    }
    if (fence) {
      out.push(theme.dim("│ ") + theme.fg("mdCode", fitLine(raw, w - 2)));
      continue;
    }
    if (raw.trim() === "") { out.push(""); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(raw))) {
      out.push(...wrapSpans(inlineSpans(m[2]), w, theme, { base: (t) => theme.bold(theme.fg("mdHeading", t)) }));
    } else if ((m = /^(\s*)([-*+])\s+(.*)$/.exec(raw))) {
      const pad = " ".repeat(Math.min(6, m[1].length));
      out.push(...wrapSpans(inlineSpans(m[3]), w, theme, { first: pad + theme.fg("mdListBullet", "• "), firstW: pad.length + 2, rest: pad + "  ", restW: pad.length + 2, base: baseP }));
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw))) {
      const pad = " ".repeat(Math.min(6, m[1].length));
      const label = `${m[2]}. `;
      out.push(...wrapSpans(inlineSpans(m[3]), w, theme, { first: pad + theme.muted(label), firstW: pad.length + visibleWidth(label), rest: " ".repeat(pad.length + label.length), restW: pad.length + label.length, base: baseP }));
    } else if ((m = /^>\s?(.*)$/.exec(raw))) {
      out.push(...wrapSpans(inlineSpans(m[1]), w, theme, { first: theme.dim("▏ "), firstW: 2, rest: theme.dim("▏ "), restW: 2, base: (t) => theme.muted(t) }));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push(theme.dim("─".repeat(Math.min(w, 40))));
    } else {
      out.push(...wrapSpans(inlineSpans(raw), w, theme, { base: baseP }));
    }
  }
  while (out.length && out.at(-1) === "") out.pop();
  return out;
}
