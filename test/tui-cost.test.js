import test from "node:test";
import assert from "node:assert/strict";
import { formatCost, renderBand } from "../lib/tui/band.js";
import { Editor } from "../lib/tui/editor.js";
import { resolvePrice } from "../lib/price.js";
import { composeFrame, ROOMY_MIN_ROWS } from "../lib/tui/screen.js";
import { initialState, reduce, requestCost } from "../lib/tui/state.js";
import { createTheme } from "../lib/tui/theme.js";
import { stripAnsi } from "../lib/tui/width.js";

const theme = createTheme({ mode: "none" });
const usage = { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 10000, cacheWriteTokens: 1000 };
const message = { type: "notification", method: "session.event", params: { sessionId: "s", event: { type: "assistant/message", turn: 1, step: 1, stream: [], usage, message: { role: "assistant", content: [{ type: "text", text: "Hello." }] } } } };
const after = (price) => reduce(initialState({ model: "gateway/example-model-1", sessionId: "s", contextWindow: 131072, price }), message);
const band = (state, width = 110) => renderBand(width, state, theme).map(stripAnsi).join("\n");

test("a priced route shows tokens times price, cache parts included", () => {
  const state = after({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  // (2000*3 + 500*15 + 10000*0.3 + 1000*3.75) / 1e6 = 0.02025
  assert.ok(Math.abs(state.usage.cost - 0.02025) < 1e-12);
  assert.match(band(state), /cache · \$0\.020$/);
});

test("a plan-billed login route shows $0.000, and only after a request", () => {
  assert.doesNotMatch(band(initialState({ model: "x/y", contextWindow: 1000, price: { plan: true } })), /\$/);
  assert.match(band(after({ plan: true })), /\$0\.000$/);
});

test("a route with no known price shows no cost atom", () => {
  assert.doesNotMatch(band(after(undefined)), /\$/);
});

test("a narrow band drops the cost atom whole, never sliced", () => {
  for (const width of [20, 28, 36, 44]) {
    for (const line of renderBand(width, after({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), theme).map(stripAnsi)) {
      assert.ok(!line.includes("$") || /\$0\.020/.test(line), `width ${width}: ${JSON.stringify(line)}`);
    }
  }
});

test("/new keeps the price and resets the cost", () => {
  const next = reduce(after({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), { type: "newSession", sessionId: "t" });
  assert.equal(next.usage.cost, 0);
  assert.deepEqual(next.price, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
});

test("a tier applies when the prompt passes its threshold", () => {
  const price = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, tiers: [{ inputTokensAbove: 5000, input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }] };
  assert.equal(requestCost(price, { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }), 0.003);
  assert.equal(requestCost(price, { input: 6000, output: 1000, cacheRead: 0, cacheWrite: 0 }), 0.08);
});

test("formatCost", () => {
  assert.deepEqual([0, 0.0001, 0.0204, 12.5, 1234, 3400000].map(formatCost), ["$0.000", "<$0.001", "$0.020", "$12.500", "$1.2k", "$3.4M"]);
});

test("resolvePrice: login routes are plan, a declared gateway and an unknown model have no price, a catalog row is used", async () => {
  const lookup = (provider, model) => (provider === "catalog" && model === "m" ? { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 } } : undefined);
  assert.deepEqual(await resolvePrice({ provider: "claude-code", model: "any" }), { plan: true });
  assert.deepEqual(await resolvePrice({ provider: "openai-codex", model: "any" }), { plan: true });
  assert.deepEqual(await resolvePrice({ provider: "catalog", model: "m", lookup }), { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 });
  assert.equal(await resolvePrice({ provider: "catalog", model: "m", lookup, declared: true }), undefined);
  assert.equal(await resolvePrice({ provider: "catalog", model: "other", lookup }), undefined);
  assert.equal(await resolvePrice({ provider: "catalog", model: "m", bin: "/nonexistent/bin" }), undefined, "a library that cannot load is no price, never a crash");
  assert.equal(await resolvePrice({ provider: "catalog", model: "m", lookup: () => { throw new Error("x"); } }), undefined);
});

function frame(rows, blocks = false) {
  let state = initialState({ model: "gateway/example-model-1", sessionId: "s", cwd: "/work/repo" });
  if (blocks) state = reduce(state, message);
  const f = composeFrame(state, { editor: new Editor(), scroll: 0, spinner: 0 }, { columns: 80, rows }, theme);
  return { lines: f.lines.map((l) => stripAnsi(l).trimEnd()), cursor: f.cursor };
}

test("roomy layout: a blank row above and below the header; an empty session shows nothing else", () => {
  const { lines, cursor } = frame(24);
  assert.equal(lines.length, 24);
  assert.equal(lines[0], "");
  assert.match(lines[1], /STEAK DSH/);
  assert.equal(lines[2], "");
  assert.ok(lines.slice(3, 22).every((l) => l === ""), "no intro text");
  assert.equal(lines[23], "╰─ Message");
  assert.equal(cursor.row, 23);
  assert.equal(frame(24, true).lines[3].includes("Hello."), true, "the first message starts under the gap");
});

test("compact layout under 12 rows: header on the first row, cursor on the editor row", () => {
  const { lines, cursor } = frame(ROOMY_MIN_ROWS - 1);
  assert.equal(lines.length, ROOMY_MIN_ROWS - 1);
  assert.match(lines[0], /STEAK DSH/);
  assert.equal(lines.at(-1), "╰─ Message");
  assert.equal(cursor.row, ROOMY_MIN_ROWS - 2);
});
