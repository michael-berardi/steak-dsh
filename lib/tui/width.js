/** Terminal width and grapheme utilities. Built-ins only: Intl.Segmenter does the grapheme work. */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// CSI sequences and OSC sequences (BEL or ST terminated).
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const graphemes = (text) => Array.from(segmenter.segment(String(text)), (item) => item.segment);

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, "");
}

const WIDE_RANGES = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff], [0x1f300, 0x1f5ff], [0x20000, 0x3fffd],
];
const inRanges = (code, ranges) => ranges.some(([lo, hi]) => code >= lo && code <= hi);
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]$/u;

/** Display columns of one grapheme cluster: 0 (control/combining only), 1 or 2. */
export function graphemeWidth(cluster) {
  if (cluster === "") return 0;
  const points = Array.from(cluster);
  const first = points[0].codePointAt(0);
  if (cluster === "\t") return 1;
  if (points.every((p) => ZERO_WIDTH.test(p))) return 0;
  if (cluster.includes("‍") && /\p{Extended_Pictographic}/u.test(cluster)) return 2; // ZWJ emoji sequence
  if (cluster.includes("️") && /\p{Extended_Pictographic}/u.test(cluster)) return 2; // emoji presentation
  if (points.some((p) => /\p{Regional_Indicator}/u.test(p))) return points.length >= 2 ? 2 : 1; // flag
  if (inRanges(first, WIDE_RANGES)) return 2;
  return 1;
}

/** Columns a string occupies; ANSI sequences count as zero. */
export function visibleWidth(text) {
  let total = 0;
  for (const cluster of graphemes(stripAnsi(text))) total += graphemeWidth(cluster);
  return total;
}

/** Collapse control characters and whitespace runs to single spaces. */
export function oneLine(value) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Truncate plain text to `width` columns on a grapheme boundary, ending in `…` when cut. Never slices a cluster. */
export function truncatePlain(value, width, ellipsis = "…") {
  const clean = oneLine(value);
  if (width <= 0) return "";
  if (visibleWidth(clean) <= width) return clean;
  const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
  const budget = Math.max(0, width - visibleWidth(suffix));
  let result = "";
  let used = 0;
  for (const cluster of graphemes(clean)) {
    const next = graphemeWidth(cluster);
    if (used + next > budget) break;
    result += cluster;
    used += next;
  }
  return result + suffix;
}

/**
 * Cut a string that may carry ANSI escapes to `width` columns. Escapes are copied whole and never counted;
 * a reset is appended when anything was cut so styles cannot leak. No ellipsis (use for hard clipping).
 */
export function clipAnsi(text, width) {
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  let cut = false;
  let index = 0;
  const source = String(text);
  while (index < source.length) {
    ANSI_RE.lastIndex = index;
    const match = ANSI_RE.exec(source);
    if (match && match.index === index) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    const nextEscape = match ? match.index : source.length;
    const chunk = source.slice(index, nextEscape);
    for (const cluster of graphemes(chunk)) {
      const w = graphemeWidth(cluster);
      if (used + w > width) { cut = true; break; }
      out += cluster;
      used += w;
    }
    if (cut) break;
    index = nextEscape;
  }
  return cut && out.includes("\x1b") ? out + "\x1b[0m" : out;
}

/** Pad (right) with spaces to exactly `width` columns, clipping if longer. */
export function padAnsi(text, width) {
  const clipped = visibleWidth(text) > width ? clipAnsi(text, width) : text;
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/**
 * Wrap plain text (no ANSI) into lines of at most `width` columns. Breaks at spaces, hard-breaks long words on a
 * grapheme boundary, keeps explicit newlines. `indent` prefixes continuation lines.
 */
export function wrapPlain(text, width, indent = "") {
  const limit = Math.max(1, width);
  const iw = Math.min(visibleWidth(indent), limit - 1);
  const pad = iw === visibleWidth(indent) ? indent : "";
  const lines = [];
  for (const raw of String(text).replace(/\t/g, "   ").split("\n")) {
    let cur = "";
    let curW = 0;
    let fresh = true; // nothing but the indent on this line
    let first = true;
    const flush = () => { lines.push(cur); first = false; cur = pad; curW = pad === "" ? 0 : iw; fresh = true; };
    for (const token of raw.split(/( +)/)) {
      if (token === "") continue;
      const w = visibleWidth(token);
      if (curW + w <= limit) {
        if (!(fresh && /^ +$/.test(token) && !first)) { cur += token; curW += w; fresh = false; }
        continue;
      }
      if (/^ +$/.test(token)) { flush(); continue; }
      if (!fresh) flush();
      if (curW + w <= limit) { cur += token; curW += w; fresh = false; continue; }
      for (const cluster of graphemes(token)) {
        const cw = graphemeWidth(cluster);
        if (curW + cw > limit) flush();
        cur += cluster; curW += cw; fresh = false;
      }
    }
    lines.push(cur);
  }
  return lines;
}

/** Left and right regions fitted to `width`: never slices a grapheme; right is dropped first. */
export function fitSides(leftValue, rightValue, width, minGap = 2) {
  const left = oneLine(leftValue);
  const right = oneLine(rightValue);
  if (width <= 0) return { left: "", gap: "", right: "" };
  if (!right) return { left: truncatePlain(left, width), gap: "", right: "" };
  if (!left) return { left: "", gap: "", right: truncatePlain(right, width) };
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + minGap + rw <= width) return { left, gap: " ".repeat(width - lw - rw), right };
  if (width < minGap + 8) return { left: truncatePlain(left, width), gap: "", right: "" };
  const rightBudget = Math.min(rw, Math.max(6, Math.floor(width * 0.48)));
  const leftBudget = Math.max(1, width - minGap - rightBudget);
  const fittedLeft = truncatePlain(left, leftBudget);
  const fittedRight = truncatePlain(right, width - minGap - visibleWidth(fittedLeft));
  return { left: fittedLeft, gap: " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight))), right: fittedRight };
}

/** Compact token count: 950, 1.2k, 18k, 1.2m (the Steak Pi composer vocabulary). */
export function formatTokens(value) {
  const count = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const scales = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [scale, suffix] of scales) {
    if (count >= scale) return `${Number((count / scale).toPrecision(3))}${suffix}`;
  }
  return String(count);
}

/** One display line: tabs to 3 spaces, control characters dropped, cut to `width` columns with `…`. Spaces are kept. */
export function fitLine(value, width) {
  const clean = String(value ?? "").replace(/\t/g, "   ").replace(/\r/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  if (width <= 0) return "";
  if (visibleWidth(clean) <= width) return clean;
  let out = "";
  let used = 0;
  for (const cluster of graphemes(clean)) {
    const w = graphemeWidth(cluster);
    if (used + w > width - 1) break;
    out += cluster;
    used += w;
  }
  return out + "…";
}

/** `/home/me/work` -> `~/work` when under `home`. */
export function compactCwd(cwd, home = process.env.HOME) {
  const clean = oneLine(cwd) || "~";
  if (!home) return clean;
  const h = home.replace(/\/+$/, "");
  if (clean === h) return "~";
  return clean.startsWith(`${h}/`) ? `~${clean.slice(h.length)}` : clean;
}
