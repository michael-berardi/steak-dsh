// test-timing: serial (asserts wall-clock budgets; see scripts/run-tests.mjs)
// A slow upload is not a silent model: the first-byte limit starts when the body is handed over and never runs while it moves.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { TurnRelay } from "../claude-code/turn-relay.js";
import { idleLimits } from "../claude-code/idle-policy.js";

const BODY = Buffer.alloc(8 * 1024 * 1024, 0x61);
const EVENTS = [
  { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

async function rig(handler, run) {
  const upstream = http.createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let touches = 0;
  // Budget 5 s; the first-byte limit is 1 s, far shorter than the throttled upload.
  const relay = new TurnRelay(`http://127.0.0.1:${upstream.address().port}`, 5_000, undefined, undefined, [], undefined, { PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS: "1000", STEAK_DSH_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS: "1000" });
  relay.beginTurn(undefined, undefined, [], () => { touches += 1; });
  try {
    const baseUrl = await relay.start();
    await run({ relay, baseUrl, touches: () => touches });
  } finally {
    await relay.close();
    upstream.closeAllConnections();
    upstream.close();
  }
}

test("a slow but moving upload longer than the first-byte limit completes with exactly one send", async () => {
  let requests = 0;
  let received = 0;
  await rig((request, response) => {
    requests += 1;
    request.on("data", (chunk) => { received += chunk.length; request.pause(); setTimeout(() => request.resume(), 20); });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(EVENTS.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  }, async ({ relay, baseUrl, touches }) => {
    const started = Date.now();
    const reply = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: BODY });
    await reply.text();
    await relay.settled();
    assert.ok(Date.now() - started > 1_500, "the upload must outlast the 1 s limit to prove anything");
    assert.equal(reply.status, 200, String(relay.failureDetail));
    assert.equal(requests, 1);
    assert.equal(relay.attempts, 1);
    assert.equal(relay.retries, 0);
    assert.equal(received, BODY.length);
    assert.equal(relay.waitFailure, undefined);
    assert.ok(touches() > 5, `upload progress counts as activity (${touches()} touches)`);
  });
});

test("a body that stops mid-upload fails with the named cause and is not sent again", async () => {
  let requests = 0;
  await rig((request) => {
    requests += 1;
    let first = true;
    request.on("data", () => { if (first) { first = false; request.pause(); } });
  }, async ({ relay, baseUrl }) => {
    const reply = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: BODY });
    await reply.text();
    await relay.settled();
    assert.equal(reply.status, 502);
    assert.equal(requests, 1, "a stalled upload is never resent");
    assert.equal(relay.attempts, 1);
    assert.ok(relay.waitFailure);
    assert.equal(relay.waitFailure.uploadStalled, true);
    assert.equal(relay.waitFailure.kind, undefined, "not an idle silence: recovery must not send the body again");
    assert.match(relay.waitFailure.message, /request upload stalled at \d+\.\d MB of 8\.0 MB/);
  });
});

test("no waiting line: no status sink, ticker or waiting text exists in the Claude Code route", () => {
  const root = join(import.meta.dirname, "../claude-code");
  for (const file of readdirSync(root).filter((name) => /\.(js|mjs)$/.test(name))) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /waiting on the model: /, `${file} prints a waiting line`);
    assert.doesNotMatch(source, /setStatus\(|StatusReporter|statusAfterMs/, `${file} has status plumbing`);
  }
  assert.equal("statusAfterMs" in idleLimits(300_000), false);
});
