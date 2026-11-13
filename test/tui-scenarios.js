/** Scripted action sequences for the simulator-style contract test. Pure data: the reducer and renderer do the rest. */
import { initialState } from "../lib/tui/state.js";

const SID = "5f2c9a10-0000-4000-8000-000000000001";
const note = (method, params) => ({ type: "notification", method, params });
const event = (e) => note("session.event", { sessionId: SID, event: e });
const text = (t) => ({ type: "text", text: t });
const msg = (content) => ({ role: "assistant", content });
const toolRes = (callId, t, isError) => ({ role: "tool", toolCallId: callId, isError, content: [{ type: "text", text: t }] });

export const base = () => initialState({ model: "gateway/example-model-1", effort: "high", sessionId: SID, cwd: "/work/repo", contextWindow: 131072 });

const turnStart = [note("session.status", { sessionId: SID, status: "running" }), event({ type: "turn/start", turn: 1 })];

const readCall = [
  event({ type: "tool/call", turn: 1, step: 1, callId: "c1", name: "read", arguments: JSON.stringify({ file_path: "src/pane.js" }) }),
];
const readResult = [
  event({ type: "tool/result", turn: 1, step: 1, message: toolRes("c1", Array.from({ length: 14 }, (_, i) => `${i + 1}: line ${i + 1} of the file`).join("\n")) }),
];
const editCall = event({ type: "tool/call", turn: 1, step: 2, callId: "c2", name: "edit", arguments: JSON.stringify({ file_path: "src/pane.js", old_string: "const gap = 1;", new_string: "const gap = 2;" }) });
const editResult = event({
  type: "tool/result", turn: 1, step: 2, message: toolRes("c2", "Edit applied."),
  meta: { diffs: [{ path: "src/pane.js", oldText: "function layout(w) {\n  const gap = 1;\n  return w - gap;\n}", newText: "function layout(w) {\n  const gap = 2;\n  const pad = 1;\n  return w - gap;\n}", oldStart: 40, newStart: 40 }] },
});
const bashFail = [
  event({ type: "tool/call", turn: 1, step: 3, callId: "c3", name: "bash", arguments: JSON.stringify({ command: "npm test -- --grep pane" }) }),
  event({ type: "tool/result", turn: 1, step: 3, message: toolRes("c3", "exit 1", true), error: { name: "ToolError", code: "EXIT_NONZERO", reason: "1 test failed: pane layout keeps the gap" } }),
];

export const SCENARIOS = {
  empty: { actions: [] },

  "tool-running": {
    actions: [
      { type: "submit", text: "Refine the pane layout without disturbing live sessions." },
      ...turnStart,
      event({ type: "request/context", provider: "gateway", model: "example-model-1", contextWindow: 131072 }),
      ...readCall,
    ],
    spinner: 3,
  },

  "full-turn": {
    actions: [
      { type: "submit", text: "Refine the pane layout.\nKeep the gap at 2 columns." },
      ...turnStart,
      event({ type: "request/context", provider: "gateway", model: "example-model-1", contextWindow: 131072 }),
      event({ type: "step/start", turn: 1, step: 1 }),
      event({ type: "assistant/message", turn: 1, step: 1, stream: [], usage: { inputTokens: 2100, outputTokens: 180, cacheReadTokens: 8800 }, message: msg([
        { type: "reasoning", text: "The layout helper subtracts a fixed gap. I should read the file first, then change the constant." },
        { type: "text", text: "I'll read the pane first." },
      ]) }),
      ...readCall,
      ...readResult,
      editCall,
      editResult,
      ...bashFail,
      event({ type: "step/start", turn: 1, step: 4 }),
      event({ type: "assistant/message", turn: 1, step: 4, stream: [], usage: { inputTokens: 3000, outputTokens: 420, cacheReadTokens: 9100 }, message: msg([
        { type: "text", text: "## Result\n\nThe gap is now **2 columns** and `layout()` keeps a one column pad.\n\n- the pane test still fails on the gap\n- run `npm test` after adjusting the fixture\n\n```js\nconst gap = 2;\n```" },
      ]) }),
      event({ type: "turn/end", turn: 1, reason: { kind: "completed" } }),
      note("session.status", { sessionId: SID, status: "idle" }),
    ],
  },

  approval: {
    actions: [
      { type: "submit", text: "Install the formatter." },
      ...turnStart,
      { type: "prompt", prompt: { kind: "approval", rpcId: 7, toolName: "bash", reason: "Run `npm install --save-dev formatter` in /work/repo", title: "bash", index: 0, options: [{ label: "Allow once", outcome: "allowed-once" }, { label: "Reject", outcome: "rejected" }] } },
    ],
  },

  question: {
    actions: [
      { type: "submit", text: "Pick a plan." },
      ...turnStart,
      { type: "prompt", prompt: { kind: "question", rpcId: 8, requestId: "q1", questions: [{ id: "q", header: "Fixture", question: "Which fixture should the pane test use?", options: [{ label: "tiny", description: "3 panes" }, { label: "large", description: "40 panes" }], multiSelect: false }], title: "Fixture", qi: 0, index: 1, picked: [], answers: [], typing: undefined, error: "" } },
    ],
  },

  "model-error": {
    actions: [
      { type: "submit", text: "Run it." },
      ...turnStart,
      event({ type: "turn/end", turn: 1, reason: { kind: "error", error: { message: "provider returned 429: rate limited", code: "RATE_LIMIT" } } }),
      note("session.status", { sessionId: SID, status: "idle" }),
    ],
  },

  "cancelled-then-crash": {
    actions: [
      { type: "submit", text: "Long job." },
      ...turnStart,
      ...readCall,
      { type: "cancelRequested" },
      { type: "cancelled" },
      { type: "childExit", reason: "harness exited with code 1 (out of memory)" },
    ],
  },

  // One exchange on a priced route: 2000 input, 500 output, 10000 cache read, 1000 cache write at 3/15/0.3/3.75 per million.
  "priced-turn": {
    price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    actions: [
      { type: "submit", text: "hello" },
      event({ type: "turn/start", turn: 1 }),
      event({ type: "assistant/message", turn: 1, step: 1, stream: [], usage: { inputTokens: 2000, outputTokens: 500, cacheReadTokens: 10000, cacheWriteTokens: 1000 }, message: msg([{ type: "text", text: "Hello." }]) }),
      event({ type: "turn/end", turn: 1, reason: { kind: "completed" } }),
    ],
  },
  "wide-chars": {
    actions: [
      { type: "submit", text: "日本語のテスト 🥩 éclair" },
      ...turnStart,
      event({ type: "assistant/message", turn: 1, step: 1, stream: [], usage: { inputTokens: 50, outputTokens: 12 }, message: msg([{ type: "text", text: "こんにちは世界、これは幅の広い文字を含む長い一行で、折り返しが文字の途中で切れないことを確かめます。 Done 🥩" }]) }),
      event({ type: "turn/end", turn: 1, reason: { kind: "completed" } }),
    ],
  },
};

export const SIZES = [{ columns: 80, rows: 30 }, { columns: 120, rows: 30 }];
export { SID, text };
