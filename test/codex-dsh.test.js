// The Codex route on the installed harness's own transport (skipped when dsh is not installed), against a fake backend.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createCodexAdapter, PROVIDER_ID } from "../codex/adapter.js";
import { loadCodexHarness } from "../codex/harness.js";
import { ACCOUNT, fakeBackend, fakeToken, readLoginFile, scratchHome, textEvents, toolEvents, writeLogin } from "./codex-helpers.js";

const root = join(import.meta.dirname, "..");
const dshPath = (process.env.PATH ?? "").split(delimiter).map((d) => d && join(d, "dsh")).find((p) => p && existsSync(p));
const skip = !dshPath;
const launcher = join(root, "bin", "steak-dsh");
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
const home = () => { const dir = realpathSync(scratchHome()); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const backend = async (options) => { const fake = await fakeBackend(options); cleanup.push(fake.close); return fake; };

const user = (text) => ({ role: "user", id: "u", source: { kind: "user" }, content: [{ type: "text", text }] });
const system = (text) => ({ role: "system", id: "s", source: { kind: "system-prompt" }, content: [{ type: "text", text }] });
const request = (extra = {}) => ({ provider: PROVIDER_ID, model: "row-a", messages: [system("be brief"), user("hi")], tools: [], sessionId: "sess-1", ...extra });
async function collect(adapter, options) {
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  return chunks;
}
async function rejected(promise) { try { await promise; } catch (error) { return error; } throw new Error("expected a failure"); }

async function make(options = {}, login = {}) {
  const harness = await loadCodexHarness({ entry: realpathSync(dshPath) });
  const dir = home();
  const tokens = writeLogin(dir, login);
  const fake = await backend(options);
  const notes = [];
  const adapter = createCodexAdapter(harness, { env: () => ({ STEAK_DSH_CODEX_HOME: dir }), baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl, report: (m) => notes.push(m) });
  return { harness, dir, tokens, fake, adapter, notes };
}

test("harness: the installed harness exposes the transport the route reuses", { skip }, async () => {
  const harness = await loadCodexHarness({ entry: realpathSync(dshPath) });
  assert.equal(harness.source, "harness");
  assert.equal(harness.missing, undefined);
  assert.equal(typeof harness.RouteAdapter, "function");
  assert.equal(typeof harness.catalogProvider, "function");
});

test("request: one Responses request in the subscription wire format, with the login's token and account, and the answer back with usage", { skip }, async () => {
  const { adapter, fake, tokens } = await make({ replies: [textEvents("hello there")] });
  const chunks = await collect(adapter, request({ reasoningEffort: "high" }));
  assert.equal(chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join(""), "hello there");
  assert.deepEqual(chunks.find((c) => c.type === "usage").usage, { inputTokens: 6, outputTokens: 7, totalTokens: 18, cacheReadTokens: 5 });
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.equal(fake.seen.requests.length, 1);
  const { headers, body } = fake.seen.requests[0];
  assert.equal(headers.authorization, `Bearer ${tokens.access}`);
  assert.equal(headers["chatgpt-account-id"], ACCOUNT);
  assert.equal(headers.accept, "text/event-stream");
  assert.equal(body.model, "row-a");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "be brief");
  assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.prompt_cache_key, "sess-1");
});

test("request: without an effort none is sent, so the model's own default applies; an effort the backend does not report is refused", { skip }, async () => {
  const { adapter, fake } = await make({ replies: [textEvents("ok")] });
  await collect(adapter, request());
  assert.equal("reasoning" in fake.seen.requests[0].body, false);
  const error = await rejected(collect(adapter, request({ reasoningEffort: "max" })));
  assert.equal(error.code, "UNSUPPORTED_REASONING_EFFORT");
  assert.equal(fake.seen.requests.length, 1);
  const info = await adapter.resolveModel(PROVIDER_ID, "row-a");
  assert.deepEqual(info.reasoning.efforts.map((e) => String(e.id)), ["low", "medium", "high"], "exactly the efforts the backend reports for the row");
  assert.equal(info.context.contextWindow, 111_000);
  assert.equal(info.name, "Row A (Codex)");
});

test("request: a tool call comes back in the harness's form, for the harness to run", { skip }, async () => {
  const { adapter } = await make({ replies: [toolEvents("echo", { a: 1 })] });
  const chunks = await collect(adapter, request({ tools: [{ name: "echo", description: "echo", parameters: { type: "object", properties: { a: { type: "number" } } } }] }));
  const call = chunks.find((c) => c.type === "block-end").block;
  assert.equal(call.type, "tool-call");
  assert.equal(call.name, "echo");
  assert.equal(call.arguments, "{\"a\":1}");
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});

test("request: an expired login is renewed before the request and the request carries the renewed token", { skip }, async () => {
  const renewed = fakeToken("new");
  const { adapter, fake, dir } = await make(
    { replies: [textEvents("ok")], renew: () => ({ status: 200, body: { access_token: renewed, refresh_token: "refresh-2" } }) },
    { access: fakeToken("old", { expiresInMs: -1000 }) },
  );
  await collect(adapter, request());
  assert.equal(fake.seen.renewals.length, 1);
  assert.equal(fake.seen.requests[0].headers.authorization, `Bearer ${renewed}`);
  assert.equal(readLoginFile(dir).tokens.refresh_token, "refresh-2");
});

test("request: no login and an unrenewable login fail closed with their named errors, and nothing is sent", { skip }, async () => {
  const expired = await make({}, { access: fakeToken("old", { expiresInMs: -1000 }) });
  assert.equal((await rejected(collect(expired.adapter, request()))).code, "CODEX_TOKEN_EXPIRED");
  assert.equal(expired.fake.seen.requests.length, 0);
  const none = await make();
  rmSync(join(none.dir, "auth.json"));
  assert.equal((await rejected(collect(none.adapter, request()))).code, "CODEX_NOT_LOGGED_IN");
  assert.equal(none.fake.seen.requests.length, 0);
});

test("request: a usage-limit answer from the backend is an error that names the limit, not a retry on another route", { skip }, async () => {
  const { adapter, fake } = await make({ replies: [{ status: 429, body: { error: { type: "usage_limit_reached", message: "The usage limit has been reached", plan_type: "pro" } } }] });
  const failure = await (async () => {
    try { return { chunks: await collect(adapter, request()) }; } catch (error) { return { error }; }
  })();
  const text = failure.error ? `${failure.error.code} ${failure.error.message}` : JSON.stringify(failure.chunks.at(-1));
  assert.match(text, /usage limit/i);
  assert.equal(fake.seen.requests.length, 1);
});

test("request: a model id typed by hand that the backend does not list is still sent, and the backend decides", { skip }, async () => {
  const { adapter, fake } = await make({ replies: [textEvents("ok")] });
  await collect(adapter, request({ model: "typed-by-hand" }));
  assert.equal(fake.seen.requests[0].body.model, "typed-by-hand");
});

function run(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", reject);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

test("dsh headless --patch: a model on the route answers a task, a tool call is run by the harness, and usage is reported", { skip }, async () => {
  const dir = home();
  const work = home();
  const target = join(work, "made.txt");
  const { access } = writeLogin(dir);
  const fake = await backend({ replies: [toolEvents("write", { file_path: target, content: "written by the harness\n" }), textEvents("created")] });
  const seam = join(dir, "seam.yml");
  writeFileSync(seam, JSON.stringify([{ id: "steak-codex-route", config: { baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl, home: dir } }]));
  const result = await run(["run", "--json", "--patch", seam, "--model", `${PROVIDER_ID}/row-a`, "create the file"], work, { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME });
  assert.equal(result.status, 0, result.stderr + result.stdout.slice(-800));
  const events = result.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  const final = events.find((e) => e.type === "final");
  assert.equal(final.reason.kind, "completed");
  assert.equal(final.text, "created");
  assert.equal(readFileSync(target, "utf8"), "written by the harness\n");
  assert.equal(fake.seen.requests.length, 2, "one request per harness turn: the tool call, then the answer");
  for (const seen of fake.seen.requests) assert.equal(seen.headers.authorization, `Bearer ${access}`);
  const second = fake.seen.requests[1].body.input;
  assert.ok(second.some((item) => item.type === "function_call" && item.name === "write"));
  assert.ok(second.some((item) => item.type === "function_call_output"));
  assert.ok(fake.seen.requests[0].body.tools.some((tool) => tool.name === "write" && tool.parameters), "the harness's tools go out as function tools");
  assert.equal((result.stdout + result.stderr).includes(access), false, "the token is never printed");
});
