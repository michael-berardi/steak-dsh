// The Codex route without the harness: the login file, token renewal, the model list, the adapter's listing, the launcher.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexAdapter, describeModel, levelMap, listedModel, PROVIDER_ID } from "../codex/adapter.js";
import { authFile, codexAccess, codexHome, readLogin, tokenClaims } from "../codex/auth.js";
import { CODES } from "../codex/errors.js";
import { loadCodexHarness } from "../codex/harness.js";
import { checkedUrl, clientVersion, fetchCodexModels, normalizeRow, rowsFromListing } from "../codex/models.js";
import { ACCOUNT, ROWS, fakeBackend, fakeToken, readLoginFile, scratchHome, writeLogin } from "./codex-helpers.js";

const folder = join(import.meta.dirname, "..", "codex");
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });
const home = () => { const dir = scratchHome(); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const backend = async (options) => { const fake = await fakeBackend(options); cleanup.push(fake.close); return fake; };
const envFor = (dir) => ({ STEAK_DSH_CODEX_HOME: dir });
const noNetwork = () => { throw new Error("no request expected"); };
const rejected = async (promise) => { try { await promise; } catch (error) { return error; } throw new Error("expected a failure"); };

test("the module folder imports only Node built-ins or its own files, and names no model", () => {
  const files = readdirSync(folder).filter((f) => /\.m?js$/.test(f));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const source = readFileSync(join(folder, file), "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
      assert.match(match[1], /^(node:|\.\/)/, `${file} imports ${match[1]}`);
    }
    assert.doesNotMatch(source, /\b(opus|sonnet|haiku|fable|qwen|gpt-[\w.]+|o[134]-|deepseek-v|openrouter|claude|anthropic)\b/i, `${file} names a model or another provider`);
    assert.doesNotMatch(source, /fallback(?:Model|Chain|s\b)|preferred|libertydesign|berardi/i, `${file} carries a fallback chain, a preference or a name`);
  }
});

test("the route talks only to the subscription backend and the login server: no API-key endpoint, no key from the environment", () => {
  const hosts = new Set();
  for (const file of readdirSync(folder).filter((f) => /\.m?js$/.test(f))) {
    const source = readFileSync(join(folder, file), "utf8");
    for (const match of source.matchAll(/https:\/\/[a-z0-9.-]+[a-z0-9/._-]*/gi)) hosts.add(match[0]);
    assert.doesNotMatch(source, /env\??\.\s*OPENAI_API_KEY|env\[["']OPENAI_API_KEY/, `${file} reads an API key from the environment`);
    assert.doesNotMatch(source, /\/v1\/(responses|chat|models)/, `${file} names an API-key endpoint`);
  }
  // The third entry is the name of a claim inside the token, not an endpoint.
  assert.deepEqual([...hosts].sort(), ["https://api.openai.com/auth", "https://auth.openai.com/oauth/token", "https://chatgpt.com/backend-api"]);
});

test("login: the folder comes from STEAK_DSH_CODEX_HOME, then CODEX_HOME, then the home folder", () => {
  assert.equal(codexHome({ STEAK_DSH_CODEX_HOME: "/a", CODEX_HOME: "/b" }), "/a");
  assert.equal(codexHome({ CODEX_HOME: "/b" }), "/b");
  assert.match(codexHome({}), /\.codex$/);
  assert.equal(authFile({ CODEX_HOME: "/b" }), join("/b", "auth.json"));
});

test("login: no file, a broken file, and an API-key login each fail closed with CODEX_NOT_LOGGED_IN", async () => {
  const dir = home();
  let error = await rejected(codexAccess({ env: envFor(dir), fetchImpl: noNetwork }));
  assert.equal(error.code, CODES.NOT_LOGGED_IN);
  assert.match(error.message, /codex login/);
  writeFileSync(join(dir, "auth.json"), "{not json");
  error = await rejected(codexAccess({ env: envFor(dir), fetchImpl: noNetwork }));
  assert.equal(error.code, CODES.NOT_LOGGED_IN);
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "key-value-that-must-not-be-used", tokens: null }));
  error = await rejected(codexAccess({ env: envFor(dir), fetchImpl: noNetwork }));
  assert.equal(error.code, CODES.NOT_LOGGED_IN);
  assert.match(error.message, /never uses an API key/);
  assert.doesNotMatch(error.message, /key-value-that-must-not-be-used/);
});

test("login: a token inside its lifetime is used as it is, with the account from its claims, and nothing is requested", async () => {
  const dir = home();
  const { access } = writeLogin(dir);
  const before = readFileSync(join(dir, "auth.json"), "utf8");
  assert.deepEqual(await codexAccess({ env: envFor(dir), fetchImpl: noNetwork }), { token: access, accountId: ACCOUNT });
  assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), before, "reading never rewrites the login");
  assert.equal(tokenClaims("not-a-token"), undefined);
  assert.equal((await readLogin(envFor(dir))).refreshToken, "refresh-1");
});

test("login: an expired token is renewed with the refresh token and the renewed login is saved in the CLI's format", async () => {
  const dir = home();
  writeLogin(dir, { access: fakeToken("old", { expiresInMs: -1000 }), extra: { kept: "field" } });
  const renewed = fakeToken("new");
  const fake = await backend({ renew: () => ({ status: 200, body: { access_token: renewed, refresh_token: "refresh-2", id_token: "id-2" } }) });
  const access = await codexAccess({ env: envFor(dir), tokenUrl: fake.tokenUrl });
  assert.equal(access.token, renewed);
  assert.equal(fake.seen.renewals.length, 1);
  assert.equal(fake.seen.renewals[0].body.grant_type, "refresh_token");
  assert.equal(fake.seen.renewals[0].body.refresh_token, "refresh-1");
  assert.ok(fake.seen.renewals[0].body.client_id);
  const saved = readLoginFile(dir);
  assert.deepEqual(saved.tokens, { id_token: "id-2", access_token: renewed, refresh_token: "refresh-2", account_id: ACCOUNT });
  assert.equal(saved.kept, "field");
  assert.equal(saved.auth_mode, "chatgpt");
  assert.notEqual(saved.last_refresh, "2026-01-01T00:00:00.000Z");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "auth.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["auth.json"], "no temporary file is left behind");
});

test("login: requests that arrive together share one renewal", async () => {
  const dir = home();
  writeLogin(dir, { access: fakeToken("old", { expiresInMs: -1000 }) });
  const renewed = fakeToken("new");
  const fake = await backend({ renew: () => ({ status: 200, body: { access_token: renewed, refresh_token: "refresh-2" } }) });
  const all = await Promise.all([1, 2, 3].map(() => codexAccess({ env: envFor(dir), tokenUrl: fake.tokenUrl })));
  assert.deepEqual(all.map((a) => a.token), [renewed, renewed, renewed]);
  assert.equal(fake.seen.renewals.length, 1);
});

test("login: a refused renewal fails closed with CODEX_TOKEN_EXPIRED and never echoes a token", async () => {
  const dir = home();
  const old = fakeToken("old", { expiresInMs: -1000 });
  writeLogin(dir, { access: old, refresh: "refresh-secret" });
  const fake = await backend({ renew: () => ({ status: 400, body: { error: "invalid_grant", echoed: "refresh-secret" } }) });
  const error = await rejected(codexAccess({ env: envFor(dir), tokenUrl: fake.tokenUrl }));
  assert.equal(error.code, CODES.TOKEN_EXPIRED);
  assert.match(error.message, /HTTP 400 invalid_grant/);
  assert.match(error.message, /codex login/);
  assert.doesNotMatch(error.message, /refresh-secret/);
  assert.equal(error.message.includes(old), false);
  assert.equal(readLoginFile(dir).tokens.access_token, old, "a failed renewal leaves the login untouched");
});

test("login: an expired token with no refresh token, or an unreachable login server, is CODEX_TOKEN_EXPIRED", async () => {
  const dir = home();
  writeLogin(dir, { access: fakeToken("old", { expiresInMs: -1000 }), refresh: "" });
  assert.equal((await rejected(codexAccess({ env: envFor(dir), fetchImpl: noNetwork }))).code, CODES.TOKEN_EXPIRED);
  writeLogin(dir, { access: fakeToken("old", { expiresInMs: -1000 }) });
  const error = await rejected(codexAccess({ env: envFor(dir), fetchImpl: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })) }));
  assert.equal(error.code, CODES.TOKEN_EXPIRED);
  assert.match(error.message, /ECONNREFUSED/);
});

test("login: when the CLI renewed the login first, its token is used and the file is not overwritten", async () => {
  const dir = home();
  writeLogin(dir, { access: fakeToken("old", { expiresInMs: -1000 }) });
  const theirs = fakeToken("renewed-by-cli");
  const fake = await backend({ renew: () => { writeLogin(dir, { access: theirs, refresh: "refresh-cli" }); return { status: 400, body: { error: "refresh_token_reused" } }; } });
  assert.equal((await codexAccess({ env: envFor(dir), tokenUrl: fake.tokenUrl })).token, theirs);
  assert.equal(readLoginFile(dir).tokens.refresh_token, "refresh-cli");
});

test("models: the list is asked from the backend with the login, and only the rows the backend lists are offered", async () => {
  const fake = await backend();
  const token = fakeToken("t");
  const rows = await fetchCodexModels({ access: { token, accountId: ACCOUNT }, baseUrl: fake.baseUrl, version: "1.2.3" });
  assert.deepEqual(rows.map((row) => row.id), ["row-a", "row-b"]);
  assert.deepEqual(rows[0], { id: "row-a", name: "Row A", description: "first", contextWindow: 111_000, efforts: ["low", "medium", "high"], defaultEffort: "medium", input: ["text", "image"], listed: true });
  const [call] = fake.seen.lists;
  assert.equal(call.version, "1.2.3");
  assert.equal(call.headers.authorization, `Bearer ${token}`);
  assert.equal(call.headers["chatgpt-account-id"], ACCOUNT);
  assert.deepEqual(rowsFromListing([{ slug: "x" }, { slug: "x" }, { slug: "" }, {}]).map((row) => row.id), ["x"], "a row without a visibility field is offered; repeats and empty ids are dropped");
  assert.equal(normalizeRow({ slug: "y", supported_reasoning_levels: ["low"] }).efforts[0], "low");
});

test("models: a refused login is CODEX_NOT_LOGGED_IN, any other failure CODEX_MODELS_FAILED, and neither carries the token", async () => {
  const token = fakeToken("secret-token");
  for (const [listStatus, code] of [[401, CODES.NOT_LOGGED_IN], [403, CODES.NOT_LOGGED_IN], [500, CODES.MODELS_FAILED]]) {
    const fake = await backend({ listStatus });
    const error = await rejected(fetchCodexModels({ access: { token, accountId: ACCOUNT }, baseUrl: fake.baseUrl }));
    assert.equal(error.code, code);
    assert.match(error.message, new RegExp(`HTTP ${listStatus}: list refused`));
    assert.equal(error.message.includes(token), false);
  }
  const down = await rejected(fetchCodexModels({ access: { token, accountId: ACCOUNT }, fetchImpl: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })) }));
  assert.equal(down.code, CODES.MODELS_FAILED);
  assert.match(down.message, /ENOTFOUND/);
  const odd = await rejected(fetchCodexModels({ access: { token, accountId: ACCOUNT }, fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })) }));
  assert.match(odd.message, /no models array/);
});

test("models: the client version defaults to the newest, and an endpoint override must be https or on this machine", () => {
  assert.equal(clientVersion({}), "999.0.0");
  assert.equal(clientVersion({ STEAK_DSH_CODEX_CLIENT_VERSION: "0.150.0" }), "0.150.0");
  assert.equal(clientVersion({ STEAK_DSH_CODEX_CLIENT_VERSION: "latest; rm" }), "999.0.0");
  assert.equal(checkedUrl("https://example.test/base/", "baseUrl"), "https://example.test/base");
  assert.equal(checkedUrl("http://127.0.0.1:9/x", "baseUrl"), "http://127.0.0.1:9/x");
  assert.throws(() => checkedUrl("http://example.test", "baseUrl"), (error) => error.code === CODES.INVALID_CONFIG);
  assert.throws(() => checkedUrl("nonsense", "tokenUrl"), (error) => error.code === CODES.INVALID_CONFIG);
  assert.throws(() => createCodexAdapter({ LlmAdapter: class {}, LlmError: Error }, { baseUrl: "http://example.test" }), (error) => error.code === CODES.INVALID_CONFIG);
});

test("descriptors: effort levels, context and name come from the backend row; an undescribed id still gets a route", () => {
  assert.deepEqual(levelMap(["low", "medium", "xhigh"], { minimal: "low", max: "max" }), { off: null, minimal: "low", low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null });
  assert.equal(levelMap(["none", "low"]).off, "none");
  const row = normalizeRow(ROWS[2]);
  const described = describeModel("row-b", row, { name: "Installed name", contextWindow: 5, maxTokens: 77, cost: { input: 1 }, compat: { a: true }, thinkingLevelMap: { minimal: "low" } }, "https://example.test");
  assert.equal(described.name, "Row B");
  assert.equal(described.contextWindow, 222_000);
  assert.equal(described.maxTokens, 77);
  assert.equal(described.provider, PROVIDER_ID);
  assert.equal(described.baseUrl, "https://example.test");
  assert.deepEqual(described.input, ["text"]);
  assert.deepEqual(described.compat, { a: true });
  assert.equal(described.thinkingLevelMap.high, null);
  assert.equal(described.thinkingLevelMap.xhigh, "xhigh");
  const plain = describeModel("typed-by-hand", undefined, undefined, "https://example.test");
  assert.equal(plain.id, "typed-by-hand");
  assert.equal(plain.reasoning, true);
  assert.ok(plain.contextWindow > 0 && plain.maxTokens > 0);
  assert.deepEqual(listedModel("p", row), { provider: "p", id: "row-b", name: "Row B (Codex)", inputModalities: ["text"] });
});

test("adapter: models are the backend's list for the login; with no login it offers none and says why once", async () => {
  const harness = await loadCodexHarness({ entry: "/nonexistent" });
  assert.equal(harness.source, "fallback");
  const dir = home();
  writeLogin(dir);
  const fake = await backend();
  const notes = [];
  const adapter = createCodexAdapter(harness, { env: () => envFor(dir), baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl, report: (m) => notes.push(m) });
  assert.deepEqual((await adapter.listModels(PROVIDER_ID)).map((m) => m.id), ["row-a", "row-b"]);
  await adapter.listModels(PROVIDER_ID);
  assert.equal(fake.seen.lists.length, 1, "the list is kept for a few minutes");
  assert.equal((await adapter.resolveModel(PROVIDER_ID, "row-a")).name, "Row A (Codex)");
  assert.equal((await adapter.resolveModel(PROVIDER_ID, "typed-by-hand")).id, "typed-by-hand");
  assert.deepEqual(notes, []);

  const empty = home();
  const loggedOut = createCodexAdapter(harness, { env: () => envFor(empty), baseUrl: fake.baseUrl, report: (m) => notes.push(m) });
  assert.deepEqual(await loggedOut.listModels(PROVIDER_ID), []);
  assert.deepEqual(await loggedOut.listModels(PROVIDER_ID), []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^codex: no models offered: CODEX_NOT_LOGGED_IN: /);
});

test("adapter: without the harness's own transport a request fails with CODEX_HARNESS_UNSUPPORTED instead of guessing a wire format", async () => {
  const harness = await loadCodexHarness({ entry: "/nonexistent" });
  const dir = home();
  writeLogin(dir);
  const fake = await backend();
  const adapter = createCodexAdapter(harness, { env: () => envFor(dir), baseUrl: fake.baseUrl });
  const error = await rejected((async () => { for await (const _ of adapter.stream({ provider: PROVIDER_ID, model: "row-a", messages: [] })) { /* drain */ } })());
  assert.equal(error.code, CODES.HARNESS_UNSUPPORTED);
  assert.equal(fake.seen.requests.length, 0);
});

test("launcher: the route needs no endpoint or key, refuses an endpoint, and is left out by --stock", async () => {
  const { parseOptions, BUNDLE_ROUTE_PROVIDERS } = await import("../lib/args.js");
  assert.ok(BUNDLE_ROUTE_PROVIDERS.has(PROVIDER_ID));
  const { options } = parseOptions(["--model", `${PROVIDER_ID}/some-row`, "--effort", "high", "task"]);
  assert.equal(options.provider, PROVIDER_ID);
  assert.equal(options.model, "some-row");
  assert.equal(options.baseUrl, undefined);
  assert.throws(() => parseOptions(["--stock", "--model", `${PROVIDER_ID}/x`, "task"]), /part of the bundle that --stock leaves out/);
  assert.throws(() => parseOptions(["--model", `${PROVIDER_ID}/x`, "--base-url", "https://e.test", "--api", "openai-responses", "--key-env", "K", "task"]), /cannot name the openai-codex route/);
});
