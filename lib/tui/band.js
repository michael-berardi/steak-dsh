/**
 * The status band, ported from the Steak Pi composer band: identity region (state-glyph "◆", model, effort,
 * lifecycle status) on the left, a context meter in the spare columns, metrics flush right
 * (context percent/window, total tokens, cache share, cost). An atom that has no data is omitted, never invented.
 * Cost: what the route reports for each request when it does; otherwise tokens times the model's price in the
 * harness's model library. It is the list price of the work, also on a login billed to a plan. A route with neither
 * shows no cost atom at all.
 * Densities full -> compact -> tight; an indivisible atom that cannot fit is dropped, never sliced.
 */
import { statusPresentation } from "./state.js";
import { toneFor } from "./theme.js";
import { formatTokens, oneLine, truncatePlain, visibleWidth } from "./width.js";

const finite = (v) => (Number.isFinite(v) ? v : 0);

export function shortModel(id) {
  const clean = oneLine(id);
  if (!clean) return "no model";
  return truncatePlain(clean.split("/").at(-1) ?? clean, 24);
}

export function contextPercent(state) {
  if (!Number.isFinite(state.contextWindow) || state.contextWindow <= 0 || !Number.isFinite(state.contextTokens)) return null;
  return Math.max(0, Math.min(100, (state.contextTokens / state.contextWindow) * 100));
}

function contextPainter(state, theme) {
  const percent = contextPercent(state);
  if (percent !== null && percent >= 90) return theme.error;
  if (percent !== null && percent >= 70) return theme.warning;
  return theme.accent;
}

/** `$0.000` to three decimals; a non-zero amount under half a mill is `<$0.001`; from $1000 up `$1.2k`, `$3.4M`. */
export function formatCost(value) {
  const cost = finite(value);
  if (cost > 0 && cost < 0.0005) return "<$0.001";
  if (cost >= 1e6) return `$${(cost / 1e6).toFixed(1)}M`;
  if (cost >= 1000) return `$${(cost / 1000).toFixed(1)}k`;
  return `$${cost.toFixed(3)}`;
}

const segWidth = (segments) => visibleWidth(segments.map((s) => s.text).join(""));
const paintSegments = (segments) => segments.map((s) => s.paint(s.text)).join("");

function metricsFor(state, theme, density) {
  const compact = density !== "full";
  const tight = density === "tight";
  const metrics = [];
  if (Number.isFinite(state.contextWindow) && state.contextWindow > 0) {
    const percent = contextPercent(state);
    metrics.push({
      text: `◫${compact ? "" : " "}${percent === null ? "?" : `${percent.toFixed(0)}%`}/${formatTokens(state.contextWindow)}`,
      paint: contextPainter(state, theme),
    });
  }
  const { input, output, cacheRead, cacheWrite, requests } = state.usage;
  if (requests > 0) {
    metrics.push({ text: `${formatTokens(finite(input) + finite(output) + finite(cacheRead) + finite(cacheWrite))}${tight ? "t" : " tok"}`, paint: theme.muted });
  }
  const scale = Math.max(input, cacheRead, cacheWrite);
  // No prompt is not a zero-percent cache hit.
  if (scale > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const ratio = Math.round(100 * (cacheRead / scale) / (input / scale + cacheRead / scale + cacheWrite / scale));
    metrics.push({ text: tight ? `c${ratio}%` : `${ratio}% cache`, paint: theme.muted });
  }
  if (requests > 0 && (state.price || state.costReported)) metrics.push({ text: formatCost(state.usage.cost), paint: theme.muted });
  return metrics;
}

function joinSegments(segments, separator, theme) {
  return segments.flatMap((segment, index) => (index ? [{ text: separator, paint: theme.muted }, segment] : [segment]));
}

function identityFor(width, state, theme) {
  const status = statusPresentation(state);
  const paintStatus = toneFor(theme, status.tone);
  const statusText = oneLine(status.text);
  if (width < 14) return [{ text: truncatePlain(statusText, width), paint: paintStatus }];
  const model = shortModel(state.model);
  const effort = oneLine(state.effort);
  const reasoning = effort && effort !== "off" ? effort : "";
  const full = [
    { text: "◆ ", paint: theme.accent },
    { text: model, paint: theme.text },
    ...(reasoning ? [{ text: " · ", paint: theme.muted }, { text: reasoning, paint: theme.text }] : []),
    { text: " · ", paint: theme.muted },
    { text: statusText, paint: paintStatus },
  ];
  if (segWidth(full) <= width) return full;
  const statusBudget = Math.min(visibleWidth(statusText), Math.max(4, Math.floor(width * 0.45)));
  const effortText = reasoning ? truncatePlain(reasoning, Math.max(1, Math.floor(width / 5))) : "";
  const separator = width >= 40 ? " · " : " ";
  const modelBudget = width - statusBudget - visibleWidth(separator) - (effortText ? visibleWidth(effortText) + 1 : 0);
  return [
    { text: truncatePlain(model, modelBudget), paint: theme.text },
    ...(effortText ? [{ text: ` ${effortText}`, paint: theme.text }] : []),
    { text: separator, paint: theme.muted },
    { text: truncatePlain(statusText, statusBudget), paint: paintStatus },
  ];
}

function meter(width, state, theme) {
  if (width <= 0) return "";
  const percent = contextPercent(state);
  const used = percent === null || percent <= 0 ? 0 : percent >= 100 ? width : Math.max(1, Math.ceil((width * percent) / 100));
  return contextPainter(state, theme)("━".repeat(used)) + theme.dim("─".repeat(width - used));
}

/** Fill `spare` columns between two regions: " ━━━─── " when roomy, else a separator. */
function meterGap(spare, state, theme, hasMetrics) {
  if (!hasMetrics) return "";
  if (spare >= 6) return ` ${meter(spare - 2, state, theme)} `;
  const sep = spare >= 3 ? " · " : " ";
  return theme.muted(sep) + " ".repeat(spare - sep.length);
}

/** The band as 1–3 lines for a pane `width` columns wide. Every line fits the width. */
export function renderBand(width, state, theme) {
  const requested = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
  const safe = requested >= 20 ? requested - 1 : requested; // keep the last column blank, as Steak Pi does
  const identity = identityFor(safe, state, theme);
  const fullMetrics = joinSegments(metricsFor(state, theme, "full"), " · ", theme);
  if (fullMetrics.length === 0) return [theme.bold(paintSegments(identity))];
  const spare = safe - segWidth(identity) - segWidth(fullMetrics);
  if (spare >= 1) return [theme.bold(paintSegments(identity)) + meterGap(spare, state, theme, true) + paintSegments(fullMetrics)];
  for (const density of ["full", "compact", "tight"]) {
    const metrics = joinSegments(metricsFor(state, theme, density), density === "full" ? " · " : " ", theme);
    const room = safe - segWidth(metrics);
    if (room >= 0) return [theme.bold(paintSegments(identity)), (room >= 6 ? meterGap(room, state, theme, true) : "") + paintSegments(metrics)];
  }
  const maxRows = safe < 40 ? 2 : 1;
  const rows = [[]];
  for (const metric of metricsFor(state, theme, "tight")) {
    if (visibleWidth(metric.text) > safe) continue;
    let row = rows.at(-1);
    if (segWidth(row) + (row.length ? 1 : 0) + visibleWidth(metric.text) > safe) {
      if (rows.length >= maxRows) continue;
      rows.push([]);
      row = rows.at(-1);
    }
    if (row.length) row.push({ text: " ", paint: theme.muted });
    row.push(metric);
  }
  return [theme.bold(paintSegments(identity)), ...rows.filter((r) => r.length).map(paintSegments)];
}

/** The one-line header: `🥩  STEAK DSH` left, muted slash hints right (width-gated like Steak Pi). */
export function renderHeader(width, theme) {
  const safe = Math.max(1, width);
  const prefix = "🥩  ";
  const prefixWidth = visibleWidth(prefix);
  const paintBrand = (t) => theme.bold(theme.accent(t));
  if (safe <= prefixWidth) return paintBrand(truncatePlain(prefix, safe, "").trimEnd() || "🥩".slice(0, 0));
  const brand = "STEAK DSH";
  const contentWidth = safe - prefixWidth;
  const hints = safe >= 64 ? "/ commands · /new · /compact · /exit" : safe >= 40 ? "/ · /new · /compact" : "";
  if (!hints) return paintBrand(prefix) + paintBrand(truncatePlain(brand, contentWidth));
  const left = truncatePlain(brand, Math.max(1, contentWidth - 2 - visibleWidth(hints)));
  const rightRoom = contentWidth - visibleWidth(left);
  const right = truncatePlain(hints, Math.max(0, rightRoom - 2));
  return paintBrand(prefix) + paintBrand(left) + " ".repeat(Math.max(1, rightRoom - visibleWidth(right))) + theme.muted(right);
}
