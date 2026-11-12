import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, enableRows, DEFAULT_ROWS, TOOL_NAME } from "../plugins/more-tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const fakeLoader = (rows) => {
  const updates = [];
  const entries = rows.map((options) => ({ options, parent: { tree: { update: async (id, next) => { updates.push([id, next]); } } } }));
  return { entries: () => entries, updates };
};

test("enableRows switches off rows on, leaves rows already on, and names rows it cannot find", async () => {
  const loader = fakeLoader([{ id: "a", disabled: true, name: "x" }, { id: "b" }]);
  const result = await enableRows(loader, ["a", "b", "c"]);
  assert.deepEqual(result, { enabled: ["a"], already: ["b"], missing: ["c"] });
  assert.deepEqual(loader.updates, [["a", { id: "a", disabled: false, name: "x" }]]);
});

test("enableRows merges a row config and only touches a row that already runs when the config differs", async () => {
  const loader = fakeLoader([{ id: "s", config: { maxInlineTokens: 1, keep: true } }]);
  const first = await enableRows(loader, [{ id: "s", config: { maxInlineTokens: 5 } }]);
  assert.deepEqual(first.enabled, ["s"]);
  assert.deepEqual(loader.updates[0][1].config, { maxInlineTokens: 5, keep: true });
  const same = await enableRows(fakeLoader([{ id: "s", config: { maxInlineTokens: 5 } }]), [{ id: "s", config: { maxInlineTokens: 5 } }]);
  assert.deepEqual(same.already, ["s"]);
});

test("the default rows are the three delegation tools plus the long-work spill setting", () => {
  assert.deepEqual(DEFAULT_ROWS.map((row) => (typeof row === "string" ? row : row.id)), ["tool-subagent", "tool-subagent-control", "tool-working-directory", "spill-policy"]);
});

test("apply registers one small tool, and nothing when the row list is empty", () => {
  const registered = [];
  apply({ tools: { register: (tool) => registered.push(tool) } }, {});
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, TOOL_NAME);
  assert.ok(registered[0].description.length < 130, "the schema text stays short: it is paid on every request");
  assert.deepEqual(registered[0].parameters, { type: "object", properties: {}, additionalProperties: false });
  const none = [];
  apply({ tools: { register: (tool) => none.push(tool) } }, { rows: [] });
  assert.equal(none.length, 0);
});

const dsh = spawnSync("dsh", ["--version"], { encoding: "utf8" });
const hasDsh = dsh.status === 0;

/** A scripted OpenAI-compatible endpoint: step i answers request i; every request body is kept. */
function scriptedEndpoint(steps) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const i = requests.length;
      requests.push({ bytes: Buffer.byteLength(body), body: JSON.parse(body) });
      const step = steps[i] ?? { text: "done" };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const chunk = (delta, finish, extra = {}) => ({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
      const parts = step.tool
        ? [chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `c${i}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args ?? {}) } }] }, null), chunk({}, "tool_calls", { usage })]
        : [chunk({ role: "assistant", content: step.text }, null), chunk({}, "stop", { usage })];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of parts) res.write(`data: ${JSON.stringify(part)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port })));
}

async function runDsh(steps, patches, task = "say ok") {
  const { server, requests, port } = await scriptedEndpoint(steps);
  const dir = mkdtempSync(join(tmpdir(), "steak-more-tools-"));
  try {
    writeFileSync(join(dir, "model.yml"), `- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local:
        displayName: Local
        apiKeyEnv: FAKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${port}/v1
        compat: {supportsDeveloperRole: false}
        models:
          - {id: m, name: m, contextWindow: 100000, maxTokens: 4000, reasoningEfforts: {off: none, high: high}}
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config: {provider: local, model: m, reasoningEffort: high}
`);
    mkdirSync(join(dir, "w"));
    const args = ["headless", "--patch", join(dir, "model.yml"), ...patches.flatMap((p) => ["--patch", p]), "--json", "--permission-mode", "workspace-write", "--approval-policy", "never", task];
    const child = spawn("dsh", args, { cwd: join(dir, "w"), env: { ...process.env, FAKE_KEY: "x", DSH_HOME: join(dir, "home"), DSH_TELEMETRY_MODE: "DISABLED" }, stdio: "ignore" });
    await new Promise((resolve) => { const timer = setTimeout(() => child.kill("SIGKILL"), 90_000); child.on("close", () => { clearTimeout(timer); resolve(); }); });
    return requests;
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const names = (request) => request.body.tools.map((tool) => tool.function.name);

test("scripted model: the default bundle offers more_tools, and calling it adds the delegation tools from the next request", { skip: !hasDsh }, async () => {
  const requests = await runDsh([{ tool: "more_tools" }, { tool: "working_directory", args: { cd: tmpdir() } }, { text: "ok" }], [join(root, "cordis.patch.yml")]);
  assert.ok(requests.length >= 3, `expected 3 requests, got ${requests.length}`);
  const first = names(requests[0]);
  assert.ok(first.includes("more_tools"));
  for (const heavy of ["subagent", "working_directory", "send_message", "list_agents", "interrupt_agent"]) assert.ok(!first.includes(heavy), `${heavy} is not in the first request`);
  const second = names(requests[1]);
  for (const heavy of ["subagent", "working_directory", "send_message", "list_agents", "interrupt_agent"]) assert.ok(second.includes(heavy), `${heavy} is in the request after more_tools`);
  const result = requests[2].body.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  assert.match(result, /Available now: tool-subagent, tool-subagent-control, tool-working-directory/);
  assert.ok(!names(requests[2]).includes("goal") && !names(requests[2]).includes("subagent_fork"), "goal, workflow and fork tools stay off");
});

test("scripted model: a one-shot task never pays for the delegation tools", { skip: !hasDsh }, async () => {
  const [first, ...rest] = await runDsh([{ text: "ok" }], [join(root, "cordis.patch.yml")]);
  assert.equal(names(first).length, 14, "13 default tools plus more_tools");
  assert.equal(rest.length, 0);
});

test("scripted model: the long-work profile still works, and more_tools then has nothing left to add", { skip: !hasDsh }, async () => {
  const requests = await runDsh([{ tool: "more_tools" }, { text: "ok" }], [join(root, "cordis.patch.yml"), join(root, "long.patch.yml")]);
  assert.ok(names(requests[0]).includes("subagent"), "--long still offers the delegation tools from the first request");
  const result = requests[1].body.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  assert.match(result, /Available now/);
});
