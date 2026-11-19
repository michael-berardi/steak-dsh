// The route inside a real dsh headless run (skipped when dsh is not installed), with a local fake standing in for the service.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { writeCredential } from "../antigravity/auth.js";
import { chunk, json, scratchEnv, sse, startFake, writeConfigFile } from "./antigravity-fixture.js";
import { root } from "./cc-helpers.js";

const dshOnPath = (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, "dsh")));
const launcher = join(root, "bin", "steak-dsh");

function run(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcher, "run", "--json", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr, events: stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)) }); });
  });
}

async function setup(t, { enabled = true } = {}) {
  const fake = await startFake();
  const { home } = scratchEnv();
  const dir = realpathSync(home);
  t.after(() => { fake.close(); rmSync(dir, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HOME: join(dir, ".dsh-home") };
  if (enabled) {
    writeConfigFile(join(dir, "ag.json"), { enabled: true, clientId: "c", clientSecret: "s", baseUrls: [fake.url], tokenUrl: `${fake.url}/token`, maxRateLimitWaitMs: 1000 });
    env.STEAK_DSH_ANTIGRAVITY_CONFIG = join(dir, "ag.json");
  }
  writeCredential({ access: "tok-live-1", refresh: "ref-1", expires: Date.now() + 3_600_000, projectId: "proj-1" }, env);
  fake.on("/v1internal:fetchAvailableModels", (req, res) => json(res, 200, { models: { "m-one": { displayName: "M One", maxTokens: 100000, maxOutputTokens: 4000, supportsThinking: true } } }));
  return { fake, env, dir };
}

test("dsh headless: an antigravity model answers through the route, with usage", { skip: !dshOnPath }, async (t) => {
  const { fake, env, dir } = await setup(t);
  fake.on("/v1internal:streamGenerateContent", (req, res) => sse(res, [chunk([{ text: "hi from the fake" }], { finishReason: "STOP" }), { response: { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 } } }]));
  const { status, events, stderr } = await run(["--model", "antigravity/m-one", "say hi"], env, dir);
  assert.equal(status, 0, stderr);
  const final = events.find((e) => e.type === "final");
  assert.equal(final.reason.kind, "completed");
  assert.equal(final.text, "hi from the fake");
  const sent = fake.seen.filter((s) => s.url.startsWith("/v1internal:streamGenerateContent"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.authorization, "Bearer tok-live-1");
  assert.equal(JSON.parse(sent[0].body).model, "m-one");
});

test("dsh headless: the route requests a harness tool in pieces, the harness runs it, the result goes back with the call's name", { skip: !dshOnPath }, async (t) => {
  const { fake, env, dir } = await setup(t);
  const target = join(dir, "made.txt");
  fake.on("/v1internal:streamGenerateContent", (req, res, n) => n === 1
    ? sse(res, [
      chunk([{ functionCall: { id: "c1", name: "write", args: { file_path: target }, willContinue: true } }]),
      chunk([{ functionCall: { id: "c1", args: { content: "written by the harness\n" } } }], { finishReason: "STOP" }),
    ])
    : sse(res, [chunk([{ text: "created" }], { finishReason: "STOP" })]));
  const { status, events, stderr } = await run(["--model", "antigravity/m-one", "create the file"], env, dir);
  assert.equal(status, 0, stderr);
  assert.equal(readFileSync(target, "utf8"), "written by the harness\n");
  assert.equal(events.find((e) => e.type === "final").text, "created");
  const sent = fake.seen.filter((s) => s.url.startsWith("/v1internal:streamGenerateContent"));
  assert.equal(sent.length, 2, "one request per harness turn: the tool call, then the answer");
  const second = JSON.parse(sent[1].body).request.contents;
  assert.equal(second.at(-1).role, "user");
  assert.equal(second.at(-1).parts[0].functionResponse.name, "write");
  assert.equal(second.at(-1).parts[0].functionResponse.id, "c1");
  assert.equal(second.at(-2).role, "model");
});

test("dsh headless: a 429 beyond the bound ends the run with one named error that says when to retry", { skip: !dshOnPath }, async (t) => {
  const { fake, env, dir } = await setup(t);
  fake.on("/v1internal:streamGenerateContent", (req, res) => json(res, 429, { error: { message: "Individual quota reached. Resets in 2h3m" } }, { "Retry-After": "7380" }));
  const { events } = await run(["--model", "antigravity/m-one", "hi"], env, dir);
  const final = events.find((e) => e.type === "final");
  assert.equal(final.reason.kind, "error");
  assert.equal(final.reason.error.code, "ANTIGRAVITY_QUOTA");
  assert.match(final.reason.error.message, /retry in 2 h 3 min/);
});

test("dsh headless: with the route not turned on the model is unknown and the fake is never contacted", { skip: !dshOnPath }, async (t) => {
  const { fake, env, dir } = await setup(t, { enabled: false });
  const { events } = await run(["--model", "antigravity/m-one", "hi"], env, dir);
  assert.equal(events.find((e) => e.type === "final")?.reason.kind, "error");
  assert.equal(fake.seen.length, 0);
});
