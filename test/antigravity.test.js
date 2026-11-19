// The Antigravity route against a local fake server only: no real Google call is made.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAntigravityAdapter } from "../antigravity/adapter.js";
import { access, login, parsePasted, readCredential, writeCredential } from "../antigravity/auth.js";
import { antigravityCommand } from "../antigravity/cli.js";
import { call } from "../antigravity/client.js";
import { CONFIG_ENV, credentialPath, loadConfig, parseConfig } from "../antigravity/config.js";
import { CODES } from "../antigravity/errors.js";
import { listModels, rowFromEntry } from "../antigravity/models.js";
import { buildRequest } from "../antigravity/request.js";
import { defaultSources } from "../lib/models.js";
import { parseOptions } from "../lib/args.js";
import { chunk, collect, failure, harness, json, scratchEnv, sse, startFake, system, testConfig, user, writeConfigFile } from "./antigravity-fixture.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STREAM = "/v1internal:streamGenerateContent";
const LIST = "/v1internal:fetchAvailableModels";
const ROWS = { models: { "m-one": { displayName: "M One", maxTokens: 100000, maxOutputTokens: 4000, supportsThinking: true }, "m-plain": { supportsThinking: false } } };

/** A signed-in adapter on a fake: the credential file is written, the model list is served. */
async function rig(t, { config = {}, credential, rows = ROWS } = {}) {
  const fake = await startFake();
  const { home, env } = scratchEnv();
  t.after(() => fake.close());
  fake.on(LIST, (req, res) => json(res, 200, rows));
  writeCredential({ access: "tok-live-1", refresh: "ref-1", expires: Date.now() + 3_600_000, projectId: "proj-1", ...credential }, env);
  const cfg = testConfig(fake, config);
  const waits = [];
  const adapter = createAntigravityAdapter(harness, { config: cfg, env: () => env, timeoutMs: config.__timeoutMs, sleep: async (ms) => { waits.push(ms); } });
  return { fake, env, home, cfg, adapter, waits };
}
const req = (messages, extra = {}) => ({ provider: "antigravity", model: "m-one", messages: [system("Be brief."), ...messages], tools: [], ...extra });
const streamCalls = (fake) => fake.seen.filter((s) => s.url.startsWith(STREAM));

// ---- config and laziness ----

test("config: off without a file, or without enabled; on with it; ships no OAuth client, project or model", () => {
  const { home } = scratchEnv();
  assert.equal(loadConfig({ [CONFIG_ENV]: join(home, "missing.json") }), undefined);
  writeConfigFile(join(home, "off.json"), { enabled: false });
  assert.equal(loadConfig({ [CONFIG_ENV]: join(home, "off.json") }), undefined);
  writeConfigFile(join(home, "on.json"), { enabled: true });
  const config = loadConfig({ [CONFIG_ENV]: join(home, "on.json") }, "9.9.9");
  assert.equal(config.clientId, undefined);
  assert.equal(config.clientSecret, undefined);
  assert.equal(config.projectId, undefined);
  assert.equal(config.userAgent, "steak-dsh-antigravity/9.9.9");
  assert.deepEqual(config.baseUrls, ["https://cloudcode-pa.googleapis.com"]);
});

test("config: a wrong file is a named error that says which key, never a silently-off route", () => {
  const { home } = scratchEnv();
  writeFileSync(join(home, "bad.json"), "{nope");
  assert.throws(() => loadConfig({ [CONFIG_ENV]: join(home, "bad.json") }), /is not valid JSON/);
  assert.throws(() => parseConfig({ enabled: true, baseUrls: ["http://example.com"] }), /baseUrls\[0\].*https/);
  assert.throws(() => parseConfig({ enabled: true, baseUrls: ["https://u:p@example.com"] }), /credentials/);
  assert.throws(() => parseConfig({ enabled: true, maxRateLimitRetries: 9 }), /maxRateLimitRetries/);
  assert.throws(() => parseConfig({ enabled: true, redirectPort: 80 }), /redirectPort/);
  assert.deepEqual(parseConfig({ enabled: true, baseUrls: ["http://127.0.0.1:9"] }).baseUrls, ["http://127.0.0.1:9"]);
});

test("config: a client secret in a file other users can read is refused", { skip: process.platform === "win32" }, () => {
  const { home } = scratchEnv();
  const path = join(home, "secret.json");
  writeConfigFile(path, { enabled: true, clientId: "a", clientSecret: "b" }, 0o644);
  assert.throws(() => loadConfig({ [CONFIG_ENV]: path }), /chmod 600/);
});

test("lazy: the plugin and config import nothing of the route but node built-ins; with no config nothing registers", async () => {
  const importsOf = (file) => [...readFileSync(join(root, "antigravity", file), "utf8").matchAll(/^import (?:[^;]*? from )?"([^"]+)";/gm)].map((m) => m[1]);
  assert.deepEqual(importsOf("plugin.js").sort(), ["./config.js", "node:fs"].sort());
  assert.ok(importsOf("config.js").every((s) => s.startsWith("node:") || s === "./errors.js"));
  assert.deepEqual(importsOf("errors.js"), []);
  const { home } = scratchEnv();
  // A fresh process with no config: importing the plugin and applying it registers nothing and leaves no handle open.
  const { spawnSync } = await import("node:child_process");
  const script = `const m = await import(${JSON.stringify(join(root, "antigravity", "plugin.js"))}); let n = 0; m.apply({ effect: () => { n += 1; }, llm: { registerAdapter: () => { n += 1; } } }); console.log(JSON.stringify({ n, name: m.name }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH, [CONFIG_ENV]: join(home, "absent.json") }, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { n: 0, name: "steak-antigravity" });
});

test("lazy: the plugin registers an adapter once the config turns it on", async () => {
  const { home } = scratchEnv();
  writeConfigFile(join(home, "on.json"), { enabled: true });
  const { spawnSync } = await import("node:child_process");
  const script = `const m = await import(${JSON.stringify(join(root, "antigravity", "plugin.js"))}); const seen = []; m.apply({ effect: (f) => { f(); }, llm: { registerAdapter: (ids, a) => { seen.push(ids); } } }); console.log(JSON.stringify(seen));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { PATH: process.env.PATH, [CONFIG_ENV]: join(home, "on.json") }, timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [["antigravity"]]);
});

test("models command: the route is listed only when turned on; --stock and --base-url are refused for it", () => {
  const { home } = scratchEnv();
  assert.deepEqual(Object.keys(defaultSources({ DSH_HOME: home })), ["claude-code", "openai-codex"]);
  writeConfigFile(join(home, "steak-dsh-antigravity.json"), { enabled: true });
  assert.deepEqual(Object.keys(defaultSources({ DSH_HOME: home })), ["claude-code", "openai-codex", "antigravity"]);
  assert.throws(() => parseOptions(["--stock", "--model", "antigravity/x", "task"], { command: "run" }), /antigravity route is part of the bundle/);
  assert.throws(() => parseOptions(["--model", "antigravity/x", "--base-url", "http://x", "--api", "openai-completions", "--key-env", "K", "task"], { command: "run" }), /cannot name the antigravity route/);
});

// ---- sign in ----

function browser(extra = {}) {
  const abort = new AbortController();
  const captured = {};
  return {
    captured,
    io: {
      notify(url) {
        const auth = new URL(url);
        captured.url = auth;
        const redirect = new URL(auth.searchParams.get("redirect_uri"));
        redirect.searchParams.set("code", "code-1");
        redirect.searchParams.set("state", extra.state ? extra.state(auth.searchParams.get("state")) : auth.searchParams.get("state"));
        setTimeout(() => void fetch(redirect).catch(() => {}), 20);
      },
      prompt: (message, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("prompt aborted")))),
    },
    signal: abort.signal,
  };
}
const freePort = async () => { const { createServer } = await import("node:net"); const s = createServer(); await new Promise((r) => s.listen(0, "127.0.0.1", r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };

test("sign-in: PKCE code flow, exchange, project discovery, credential saved 0600", async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const { env } = scratchEnv();
  fake.on("/token", (req, res) => json(res, 200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 }));
  fake.on("/v1internal:loadCodeAssist", (req, res) => json(res, 200, { cloudaicompanionProject: "proj-9" }));
  const config = testConfig(fake, { redirectPort: await freePort() });
  const b = browser();
  const credential = await login(config, b.io, { env, signal: b.signal });
  assert.equal(credential.projectId, "proj-9");
  const saved = readCredential(env);
  assert.deepEqual({ a: saved.access, r: saved.refresh, p: saved.projectId }, { a: "acc-1", r: "ref-1", p: "proj-9" });
  if (process.platform !== "win32") assert.equal(statSync(credentialPath(env)).mode & 0o777, 0o600);
  const form = new URLSearchParams(fake.seen.find((s) => s.url === "/token").body);
  assert.equal(form.get("grant_type"), "authorization_code");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), b.captured.url.searchParams.get("code_challenge"));
  assert.notEqual(b.captured.url.searchParams.get("state"), form.get("code_verifier"));
  assert.equal(b.captured.url.searchParams.get("access_type"), "offline");
  assert.match(fake.seen.find((s) => s.url.startsWith("/v1internal:loadCodeAssist")).headers["user-agent"], /^steak-dsh-antigravity\//);
});

test("sign-in: a callback with a different state is refused and nothing is exchanged or saved", async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const { env } = scratchEnv();
  fake.on("/token", (req, res) => json(res, 200, { access_token: "a", refresh_token: "r", expires_in: 3600 }));
  const b = browser({ state: () => "forged" });
  await assert.rejects(login(testConfig(fake, { redirectPort: await freePort() }), b.io, { env, signal: b.signal }), /state did not match/);
  assert.equal(fake.seen.some((s) => s.url === "/token"), false);
  assert.equal(existsSync(credentialPath(env)), false);
});

test("sign-in: no OAuth client in config is a named error; no refresh token is a named error", async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const { env } = scratchEnv();
  await assert.rejects(login(testConfig(fake, { clientId: undefined, clientSecret: undefined }), browser().io, { env }), /set "clientId" and "clientSecret".*none is shipped/);
  fake.on("/token", (req, res) => json(res, 200, { access_token: "a", expires_in: 3600 }));
  const b = browser();
  await assert.rejects(login(testConfig(fake, { redirectPort: await freePort() }), b.io, { env, signal: b.signal }), /no refresh token/);
});

test("sign-in: a pasted callback is accepted, and one from another sign-in is not", () => {
  assert.deepEqual(parsePasted("http://localhost:1/oauth-callback?code=c&state=s", "s"), { code: "c", state: "s" });
  assert.deepEqual(parsePasted("?code=c&state=s", "s"), { code: "c", state: "s" });
  assert.throws(() => parsePasted("?code=c&state=x", "s"), /different sign-in/);
  assert.throws(() => parsePasted("", "s"), /Nothing was pasted/);
});

test("token: an expired access token is renewed from the refresh token and the renewal is saved", async (t) => {
  const { fake, env, cfg } = await rig(t, { credential: { expires: Date.now() - 1000 } });
  fake.on("/token", (req, res) => json(res, 200, { access_token: "tok-2", expires_in: 3600 }));
  const session = await access({ config: cfg, env });
  assert.equal(session.token, "tok-2");
  assert.equal(new URLSearchParams(fake.seen.find((s) => s.url === "/token").body).get("refresh_token"), "ref-1");
  assert.deepEqual({ a: readCredential(env).access, r: readCredential(env).refresh }, { a: "tok-2", r: "ref-1" });
});

test("token: a refused refresh token is a named expiry that says to sign in again and never prints a token", async (t) => {
  const { fake, env, cfg } = await rig(t, { credential: { expires: Date.now() - 1000, refresh: "1//abcdefghijklmnopqrstuvwxyz" } });
  fake.on("/token", (req, res) => json(res, 400, { error: "invalid_grant", error_description: "revoked. refresh_token=1//abcdefghijklmnopqrstuvwxyz" }));
  const error = await access({ config: cfg, env }).catch((e) => e);
  assert.equal(error.code, CODES.AUTH_EXPIRED);
  assert.match(error.message, /invalid_grant.*antigravity login/);
  assert.doesNotMatch(error.message, /1\/\/abc/);
});

test("token: no sign-in, or an unreadable one, is named and never quoted", () => {
  const { env, home } = scratchEnv();
  assert.throws(() => readCredential(env), /No Antigravity sign-in.*antigravity login/);
  writeFileSync(join(home, "steak-dsh-antigravity-auth.json"), "garbage tok-secret");
  try { readCredential(env); assert.fail("should throw"); } catch (e) { assert.match(e.message, /unreadable/); assert.doesNotMatch(e.message, /tok-secret/); }
});

// ---- models ----

test("models: the list is the provider's, minus what is not a chat model; no id is written in source", async (t) => {
  const { fake, cfg } = await rig(t, { rows: { models: { alpha: { displayName: "Alpha", maxTokens: 200000, maxOutputTokens: 16000, supportsThinking: true }, beta: {}, "gamma-image": {}, chat_x: {}, MODEL_PLACEHOLDER_1: {}, off: { disabled: true }, "bad id": {} } } });
  const rows = await listModels(cfg, { token: "t", projectId: "p-1" });
  assert.deepEqual(rows.map((r) => r.id), ["alpha", "beta"]);
  assert.deepEqual(rows[0], { id: "alpha", name: "Alpha", reasoning: true, contextWindow: 200000, maxTokens: 16000 });
  assert.deepEqual(JSON.parse(fake.seen.at(-1).body), { project: "p-1" });
  assert.deepEqual(rowFromEntry("x", {}), { id: "x", name: "x", reasoning: false, contextWindow: 128000, maxTokens: 8192 });
});

test("models: an empty or malformed list is a named error, not an empty picker", async (t) => {
  const { fake, cfg } = await rig(t);
  fake.on(LIST, (req, res) => json(res, 200, { models: {} }));
  await assert.rejects(listModels(cfg, { token: "t", projectId: "p" }), /no usable chat models/);
  fake.on(LIST, (req, res) => json(res, 200, { nope: 1 }));
  await assert.rejects(listModels(cfg, { token: "t", projectId: "p" }), /no `models` object/);
});

test("adapter: listModels offers the account's models; signed out it offers none and says why once", async (t) => {
  const { adapter, env } = await rig(t);
  const listed = await adapter.listModels("antigravity");
  assert.deepEqual(listed.map((m) => m.id), ["m-one", "m-plain"]);
  assert.deepEqual(listed[0].inputModalities, ["text"]);
  const resolved = await adapter.resolveModel("antigravity", "m-one");
  assert.equal(resolved.context.contextWindow, 100000);
  assert.deepEqual(resolved.reasoning.efforts.map((e) => e.name), ["minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal((await adapter.resolveModel("antigravity", "m-plain")).reasoning, undefined);
  const fake2 = await startFake();
  t.after(() => fake2.close());
  const reports = [];
  const signedOut = createAntigravityAdapter(harness, { config: testConfig(fake2), env: () => ({ DSH_HOME: join(env.DSH_HOME, "nobody") }), report: (m) => reports.push(m) });
  assert.deepEqual(await signedOut.listModels("antigravity"), []);
  await signedOut.listModels("antigravity");
  assert.equal(reports.length, 1);
  assert.match(reports[0], /ANTIGRAVITY_AUTH_EXPIRED: No Antigravity sign-in/);
  assert.equal(fake2.seen.length, 0);
});

// ---- a streamed turn ----

test("stream: thinking, text, a tool call in pieces, another call, and usage map to harness chunks", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on(STREAM, (req, res) => sse(res, [
    chunk([{ text: "Let me ", thought: true }]),
    chunk([{ text: "think.", thought: true, thoughtSignature: "sig-think" }]),
    chunk([{ text: "Hello " }]), chunk([{ text: "there." }]),
    chunk([{ functionCall: { id: "c1", name: "read", args: { path: "a.txt" }, willContinue: true } }]),
    chunk([{ functionCall: { id: "c1", args: { limit: 5 }, willContinue: true } }]),
    chunk([{ functionCall: { id: "c1", args: { offset: 2 } } }]),
    chunk([{ functionCall: { name: "write", args: { path: "b.txt" } }, thoughtSignature: "sig-call" }], { finishReason: "STOP" }),
    { response: { usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 160 } } },
  ]));
  const chunks = await collect(adapter, req([user("hi")], { reasoningEffort: "medium", tools: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }, { name: "write", description: "Write", parameters: { type: "object", properties: {} } }] }));
  const ends = chunks.filter((c) => c.type === "block-end").map((c) => c.block);
  assert.deepEqual(ends.map((b) => b.type), ["reasoning", "text", "tool-call", "tool-call"]);
  assert.equal(ends[0].text, "Let me think.");
  assert.equal(ends[1].text, "Hello there.");
  assert.deepEqual({ id: ends[2].id, name: ends[2].name, args: JSON.parse(ends[2].arguments) }, { id: "c1", name: "read", args: { path: "a.txt", limit: 5, offset: 2 } });
  assert.equal(ends[3].name, "write");
  assert.deepEqual(chunks.filter((c) => c.type === "block-start").map((c) => c.blockType), ["reasoning", "text", "tool-call", "tool-call"]);
  const usage = chunks.find((c) => c.type === "usage").usage;
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 40, totalTokens: 160, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 10 });
  const finish = chunks.at(-1);
  assert.equal(finish.type, "finish");
  assert.equal(finish.reason.kind, "tool-calls");
  // The provider's signatures ride in the replay state.
  const parts = finish.replayState.response.parts;
  assert.equal(parts[0].thoughtSignature, "sig-think");
  assert.equal(parts.at(-1).thoughtSignature, "sig-call");
});

test("stream: the request envelope carries project, model, system, tools, thinking and the configured agent", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
  await collect(adapter, req([user("hi")], { reasoningEffort: "high", maxTokens: 9999, sessionId: "s-1", tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] }));
  const sent = streamCalls(fake)[0];
  assert.equal(sent.url, `${STREAM}?alt=sse`);
  assert.equal(sent.headers.authorization, "Bearer tok-live-1");
  assert.match(sent.headers["user-agent"], /^steak-dsh-antigravity\//);
  const body = JSON.parse(sent.body);
  assert.deepEqual({ p: body.project, m: body.model, t: body.requestType }, { p: "proj-1", m: "m-one", t: "agent" });
  assert.equal(body.request.systemInstruction.parts[0].text, "Be brief.");
  assert.deepEqual(body.request.generationConfig, { maxOutputTokens: 4000, thinkingConfig: { includeThoughts: true, thinkingBudget: 16384 } });
  assert.equal(body.request.tools[0].functionDeclarations[0].name, "read");
  assert.equal(body.request.sessionId, "s-1");
  assert.deepEqual(body.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
});

test("stream: history replay uses the saved provider parts (signatures), tool results answer by call name in one user turn", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
  const call1 = { type: "tool-call", id: "a", name: "t1", arguments: '{"x":1}' };
  const call2 = { type: "tool-call", id: "b", name: "t2", arguments: "{}" };
  const content = [{ type: "reasoning", text: "hm" }, call1, call2];
  const saved = { response: { version: 1, parts: [{ text: "hm", thought: true, thoughtSignature: "s1" }, { functionCall: { id: "a", name: "t1", args: { x: 1 } }, thoughtSignature: "s2" }, { functionCall: { id: "b", name: "t2", args: {} } }], projection: { text: "", toolCalls: [{ id: "a", name: "t1", input: { x: 1 } }, { id: "b", name: "t2", input: {} }] } } };
  await collect(adapter, req([user("go"), { role: "assistant", id: "x", source: { replayState: saved }, content }, { role: "tool", toolCallId: "a", content: [{ type: "text", text: "A" }] }, { role: "tool", toolCallId: "b", isError: true, content: [{ type: "text", text: "boom" }] }]));
  const contents = JSON.parse(streamCalls(fake)[0].body).request.contents;
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "go" }] },
    { role: "model", parts: saved.response.parts },
    { role: "user", parts: [{ functionResponse: { id: "a", name: "t1", response: { output: "A" } } }, { functionResponse: { id: "b", name: "t2", response: { error: "boom" } } }] },
  ]);
  // A saved copy that no longer matches the message is not trusted: the message is rebuilt without the reasoning.
  const edited = { role: "assistant", id: "x", source: { replayState: saved }, content: [call1] };
  const rebuilt = buildRequest(req([user("go"), edited, { role: "tool", toolCallId: "a", content: [{ type: "text", text: "A" }] }]), { id: "m-one", maxTokens: 10, reasoning: true }, "p");
  assert.deepEqual(rebuilt.request.contents[1], { role: "model", parts: [{ functionCall: { id: "a", name: "t1", args: { x: 1 } } }] });
});

test("stream: an image block is named in text (the route is text-only), a result with no matching call is a named error", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
  await collect(adapter, req([{ role: "user", id: "u", source: {}, content: [{ type: "text", text: "see" }, { type: "image", attachment: { name: "p.png" } }] }]));
  assert.deepEqual(JSON.parse(streamCalls(fake)[0].body).request.contents[0].parts, [{ text: "see" }, { text: "[image: p.png omitted: this route takes text only]" }]);
  const error = await failure(adapter, req([user("x"), { role: "tool", toolCallId: "ghost", content: [] }]));
  assert.equal(error.code, CODES.PROTOCOL);
  assert.match(error.message, /"ghost".*no earlier assistant message/);
});

test("stream: thinking on a model without it, an unknown effort, and an unlisted model are named errors before any request", async (t) => {
  const { fake, adapter } = await rig(t);
  const a = await failure(adapter, req([user("hi")], { model: "m-plain", reasoningEffort: "low" }));
  assert.equal(a.code, CODES.UNSUPPORTED);
  assert.match(a.message, /does not support thinking/);
  const b = await failure(adapter, req([user("hi")], { reasoningEffort: "extreme" }));
  assert.match(b.message, /not one this route knows/);
  const c = await failure(adapter, req([user("hi")], { model: "nope" }));
  assert.match(c.message, /"nope" is not in this account's list.*models --provider antigravity/);
  assert.equal(streamCalls(fake).length, 0);
});

test("stream: stop reasons: length maps, a safety stop and a missing finish reason are named errors", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "cut" }], { finishReason: "MAX_TOKENS" })]));
  assert.equal((await collect(adapter, req([user("hi")]))).at(-1).reason.kind, "max-tokens");
  fake.on(STREAM, (req, res) => sse(res, [chunk([], { finishReason: "SAFETY" })]));
  assert.match((await failure(adapter, req([user("hi")]))).message, /"SAFETY"/);
  fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "part" }])]));
  const cut = await failure(adapter, req([user("hi")]));
  assert.equal(cut.code, CODES.PROTOCOL);
  assert.match(cut.message, /without a finish reason after a partial reply/);
  fake.on(STREAM, (req, res) => sse(res, [{ error: { code: 500, message: "internal glitch" } }]));
  assert.match((await failure(adapter, req([user("hi")]))).message, /mid-stream \(500\).*internal glitch/);
});

// ---- failures ----

test("401: refreshes once, retries with the new token, saves it, and succeeds", async (t) => {
  const { fake, adapter, env } = await rig(t);
  fake.on("/token", (req, res) => json(res, 200, { access_token: "tok-new", expires_in: 3600 }));
  fake.on(STREAM, (req, res, n) => n === 1 ? json(res, 401, { error: { message: "token expired" } }) : sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
  const chunks = await collect(adapter, req([user("hi")]));
  assert.equal(chunks.at(-1).reason.kind, "stop");
  assert.deepEqual(streamCalls(fake).map((s) => s.headers.authorization), ["Bearer tok-live-1", "Bearer tok-new"]);
  assert.equal(fake.seen.filter((s) => s.url === "/token").length, 1);
  assert.equal(readCredential(env).access, "tok-new");
});

test("401 again after the one refresh is a named expiry; no second refresh", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on("/token", (req, res) => json(res, 200, { access_token: "tok-new", expires_in: 3600 }));
  fake.on(STREAM, (req, res) => json(res, 401, { error: { message: "token expired" } }));
  const error = await failure(adapter, req([user("hi")]));
  assert.equal(error.code, CODES.AUTH_EXPIRED);
  assert.match(error.message, /rejected the access token \(HTTP 401.*even after one refresh.*antigravity login/);
  assert.doesNotMatch(error.message, /tok-/);
  assert.equal(fake.seen.filter((s) => s.url === "/token").length, 1);
  assert.equal(streamCalls(fake).length, 2);
});

test("429 with Retry-After waits the stated time (bounded) and then succeeds", async (t) => {
  const { fake, adapter, waits } = await rig(t);
  fake.on(STREAM, (req, res, n) => n === 1 ? json(res, 429, { error: { message: "Rate limit, slow down" } }, { "Retry-After": "2" }) : sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
  assert.equal((await collect(adapter, req([user("hi")]))).at(-1).type, "finish");
  assert.deepEqual(waits, [2000]);
});

test("429 whose wait is longer than the bound fails at once and says when to retry", async (t) => {
  const { fake, adapter, waits } = await rig(t);
  fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Individual quota reached. Resets in 2h3m" } }, { "Retry-After": "7380" }));
  const error = await failure(adapter, req([user("hi")]));
  assert.equal(error.code, CODES.QUOTA);
  assert.equal(error.cause.retryAfterMs, 7_380_000);
  assert.match(error.message, /quota reached \(HTTP 429\).*retry in 2 h 3 min/);
  assert.deepEqual(waits, []);
  assert.equal(streamCalls(fake).length, 1);
});

test("429 that keeps coming is resent only the configured number of times, then named", async (t) => {
  const { fake, cfg } = await rig(t, { config: { maxRateLimitRetries: 2 } });
  fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Too many requests" } }, { "Retry-After": "1" }));
  const waits = [];
  const error = await call(cfg, { token: "t", projectId: "p" }, STREAM, {}, "stream", { sleep: async (ms) => { waits.push(ms); } }).catch((e) => e);
  assert.equal(error.code, CODES.RATE_LIMITED);
  assert.match(error.message, /rate limit \(HTTP 429 after 2 bounded waits\).*retry in 1 s/);
  assert.deepEqual(waits, [1000, 1000]);
  assert.equal(streamCalls(fake).length, 3);
});

test("429 with no retry time says so; 403 and 404 are named with their cause", async (t) => {
  const { fake, adapter } = await rig(t);
  fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Resource has been exhausted" } }));
  assert.match((await failure(adapter, req([user("hi")]))).message, /the provider gave no retry time/);
  fake.on(STREAM, (req, res) => json(res, 403, { error: { message: "Verify your account" } }));
  assert.match((await failure(adapter, req([user("hi")]))).message, /refused access \(HTTP 403: Verify your account\)/);
  fake.on(STREAM, (req, res) => json(res, 404, { error: { message: "Requested entity was not found" } }));
  assert.match((await failure(adapter, req([user("hi")]))).message, /not found \(HTTP 404.*model may not be available/);
});

test("a wait for a rate limit can be cancelled", async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const cfg = testConfig(fake);
  fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Rate limit" } }, { "Retry-After": "4" }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("cancelled by test")), 100);
  const started = Date.now();
  await assert.rejects(call(cfg, { token: "t", projectId: "p" }, STREAM, {}, "stream", { signal: controller.signal }), /cancelled by test/);
  assert.ok(Date.now() - started < 3000);
});

test("a stalled stream is cut at the idle limit with the silence stated", async (t) => {
  const { fake, adapter } = await rig(t, { config: { __timeoutMs: 120 } });
  fake.on(STREAM, (req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify(chunk([{ text: "a" }]))}\n\n`); });
  const started = Date.now();
  const error = await failure(adapter, req([user("hi")]));
  assert.equal(error.code, CODES.IDLE);
  assert.match(error.message, /stream idle for \d+ s \(\d+ bytes received\)/);
  assert.ok(Date.now() - started < 3000);
});

test("a connection that never answers is cut at the first-byte limit; a stalled upload is named and not sent again", async (t) => {
  const { fake, adapter, cfg } = await rig(t, { config: { __timeoutMs: 120 } });
  fake.on(STREAM, () => { /* never responds */ });
  const idle = await failure(adapter, req([user("hi")]));
  assert.match(idle.message, /no response for \d+ s after the request was sent/);
  let connections = 0;
  fake.raw("/stall", (r) => { connections += 1; r.pause(); });
  const { post } = await import("../antigravity/transport.js");
  const error = await post(`${fake.url}/stall`, Buffer.alloc(48 * 1024 * 1024, 1), { headers: {}, limits: { firstByteMs: 400, streamIdleMs: 400 }, label: "stream" }).catch((e) => e);
  assert.equal(error.code, CODES.UPLOAD_STALLED);
  assert.match(error.message, /upload stalled at [\d.]+ MB of 48\.0 MB.*not sent again/);
  assert.ok(connections <= 1);
  void cfg;
});

test("abort mid-stream ends the request", async (t) => {
  const { fake, adapter } = await rig(t);
  const controller = new AbortController();
  fake.on(STREAM, (req, res) => { res.writeHead(200); res.write(`data: ${JSON.stringify(chunk([{ text: "a" }]))}\n\n`); setTimeout(() => controller.abort(new Error("stop")), 30); });
  await assert.rejects(collect(adapter, req([user("hi")], { signal: controller.signal })), /stop/);
});

test("the next endpoint is tried only when the first cannot be reached; a refusal is not passed on; only configured hosts are contacted", async (t) => {
  const { fake, env } = await rig(t);
  fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
  const dead = "http://127.0.0.1:9";
  const failover = createAntigravityAdapter(harness, { config: testConfig(fake, { baseUrls: [dead, fake.url] }), env: () => env });
  assert.equal((await collect(failover, req([user("hi")]))).at(-1).type, "finish");
  fake.seen.length = 0;
  fake.on(STREAM, (req, res) => json(res, 403, { error: { message: "no" } }));
  const refused = createAntigravityAdapter(harness, { config: testConfig(fake, { baseUrls: [fake.url, dead] }), env: () => env });
  assert.match((await failure(refused, req([user("hi")]))).message, /403/);
  assert.equal(streamCalls(fake).length, 1);
  assert.ok(fake.seen.every((s) => s.headers.host === new URL(fake.url).host));
});

// ---- command, neutrality ----

test("antigravity command: login, status and logout; not turned on is a named error", async (t) => {
  const fake = await startFake();
  t.after(() => fake.close());
  const { home, env } = scratchEnv();
  fake.on("/token", (req, res) => json(res, 200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 }));
  fake.on("/v1internal:loadCodeAssist", (req, res) => json(res, 200, { cloudaicompanionProject: "proj-9" }));
  let out = "";
  const io = { env, out: (t2) => { out += t2; }, err: (t2) => { out += t2; } };
  await assert.rejects(antigravityCommand(["login"], io), /not turned on.*steak-dsh-antigravity\.json/);
  writeConfigFile(join(home, "steak-dsh-antigravity.json"), { enabled: true, clientId: "c", clientSecret: "s", baseUrls: [fake.url], authUrl: `${fake.url}/auth`, tokenUrl: `${fake.url}/token`, redirectPort: await freePort() });
  // The prompt never answers; a "browser" follows the printed address.
  const prompt = (message, signal) => {
    const url = new URL(out.split("\n").find((l) => l.startsWith(fake.url)));
    const redirect = new URL(url.searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", "code-1");
    redirect.searchParams.set("state", url.searchParams.get("state"));
    setTimeout(() => void fetch(redirect).catch(() => {}), 20);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  assert.equal(await antigravityCommand(["login"], { ...io, prompt }), 0);
  assert.match(out, /signed in to Antigravity/);
  assert.equal(readCredential(env).projectId, "proj-9");
  out = "";
  assert.equal(await antigravityCommand(["status"], io), 0);
  assert.match(out, /signed in; project proj-9; access token valid/);
  assert.doesNotMatch(out, /acc-1|ref-1/);
  assert.equal(await antigravityCommand(["logout"], io), 0);
  assert.equal(existsSync(credentialPath(env)), false);
});

test("neutrality: no model, vendor model family, OAuth client or account in the route's source; only the provider's own hosts", () => {
  const files = readdirSync(join(root, "antigravity")).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 9);
  const forbidden = /\b(?:gemini|claude|gpt|opus|sonnet|haiku|deepseek|llama|mistral)\b|[\w-]*-\d+[.\-\d]*(?:-(?:low|medium|high|flash|pro))\b|GOCSPX-[\w-]{10,}|apps\.googleusercontent\.com|@gmail\.com/i;
  const hosts = new Set();
  for (const file of files) {
    const text = readFileSync(join(root, "antigravity", file), "utf8");
    // Reusing the Claude Code route's wait helpers is a path and a comment, not a model choice.
    const bare = (l) => l.replace(/\.\.\/claude-code\//g, "").replace(/Claude Code relay/g, "");
    assert.deepEqual(text.split("\n").filter((l) => forbidden.test(bare(l))), [], file);
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]);
  }
  for (const host of ["cloudcode-pa.googleapis.com", "accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"]) hosts.delete(host);
  assert.deepEqual([...hosts].filter((h) => !/^(?:localhost|127\.0\.0\.1|example\.com)$/.test(h)), []);
});
