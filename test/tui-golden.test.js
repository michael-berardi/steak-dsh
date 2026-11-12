import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Editor } from "../lib/tui/editor.js";
import { composeFrame, frameText } from "../lib/tui/screen.js";
import { reduce } from "../lib/tui/state.js";
import { createTheme } from "../lib/tui/theme.js";
import { stripAnsi, visibleWidth } from "../lib/tui/width.js";
import { SCENARIOS, SIZES, base } from "./tui-scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden", "tui");
mkdirSync(goldenDir, { recursive: true });

/** Compare against a golden file; UPDATE_GOLDEN=1 rewrites it. A missing golden is a failure, never a silent pass. */
function golden(name, actual) {
  const path = join(goldenDir, name);
  if (process.env.UPDATE_GOLDEN === "1") { writeFileSync(path, actual); return; }
  assert.ok(existsSync(path), `missing golden ${name}; run UPDATE_GOLDEN=1 node --test test/tui-golden.test.js`);
  assert.equal(actual, readFileSync(path, "utf8"), `golden ${name} differs`);
}

function render(name, size, { mode = "none", typed = "" } = {}) {
  const scenario = SCENARIOS[name];
  let state = base();
  for (const action of scenario.actions) state = reduce(state, action);
  const editor = new Editor();
  if (typed) editor.insert(typed);
  const theme = createTheme({ mode });
  return { frame: composeFrame(state, { editor, scroll: 0, spinner: scenario.spinner ?? 0 }, size, theme), state };
}

for (const name of Object.keys(SCENARIOS)) {
  for (const size of SIZES) {
    test(`golden frame: ${name} at ${size.columns} columns`, () => {
      const { frame } = render(name, size);
      assert.equal(frame.lines.length, size.rows, "the frame fills the terminal height exactly");
      for (const line of frame.lines) assert.ok(visibleWidth(line) <= size.columns, `line wider than ${size.columns}: ${JSON.stringify(stripAnsi(line))}`);
      assert.ok(!frame.lines.join("").includes("\x1b"), "no ANSI when colour is off");
      golden(`${name}.${size.columns}.txt`, frameText(frame, stripAnsi));
    });
  }
}

test("golden frame: ANSI (truecolor) full turn at 80 columns", () => {
  const { frame } = render("full-turn", SIZES[0], { mode: "truecolor" });
  // ESC shown as ␛ so the golden is readable and diffable.
  golden("full-turn.80.ansi.txt", frame.lines.map((l) => l.replace(/\x1b/g, "␛")).join("\n") + "\n");
  assert.equal(frameText(frame, stripAnsi), readFileSync(join(goldenDir, "full-turn.80.txt"), "utf8"), "stripping ANSI gives the plain golden");
});

test("the status band follows the Steak Pi order and vocabulary", () => {
  const { frame } = render("full-turn", SIZES[1]);
  const band = frame.lines.find((l) => l.includes("◆ example-model-1"));
  assert.match(band, /^◆ example-model-1 · high · ✓ complete .*◫ \d+%\/131k · [\d.]+k tok · \d+% cache$/u);
  assert.ok(!/\$/.test(band), "no cost atom is invented");
});

test("an atom without data is omitted: the empty screen shows no tokens, cache or percentage", () => {
  const { frame } = render("empty", SIZES[1]);
  const band = stripAnsi(frame.lines.find((l) => l.startsWith("◆")));
  assert.match(band, /● new session/);
  assert.match(band, /◫ \?\/131k$/u, "a known window with no request yet reads ?/window");
  assert.ok(!/tok|cache/.test(band));
});

test("the editor shows typed text with the gutter and places the cursor after it", () => {
  const { frame } = render("empty", SIZES[0], { typed: "hello\nsecond line" });
  const text = frame.lines.map(stripAnsi);
  const i = text.findIndex((l) => l.startsWith("╰─ hello"));
  assert.ok(i >= 0 && text[i + 1] === "   second line");
  assert.deepEqual(frame.cursor, { row: i + 1, col: 3 + "second line".length });
});

test("a short terminal still gets a valid frame (every region kept, viewport shrinks)", () => {
  for (const rows of [6, 8, 12]) {
    const { frame } = render("full-turn", { columns: 60, rows });
    assert.equal(frame.lines.length, rows);
    assert.ok(frame.lines.every((l) => visibleWidth(l) <= 60));
  }
});
