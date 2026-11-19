// A local fake of the provider's endpoints. The tests never call a real service: every URL in a test config points here.
import http from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../antigravity/config.js";
import { loadHarness } from "../claude-code/harness.js";

export const harness = await loadHarness({ entry: "/nonexistent" });

export async function startFake() {
  const handlers = new Map();
  const rawHandlers = new Map();
  const counts = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    const rawKey = [...rawHandlers.keys()].find((k) => (req.url ?? "").startsWith(k));
    if (rawKey) { rawHandlers.get(rawKey)(req, res); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const record = { method: req.method, url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(record);
      const key = [...handlers.keys()].find((k) => record.url.startsWith(k));
      if (!key) { res.writeHead(404).end(JSON.stringify({ error: { message: `no handler for ${record.url}` } })); return; }
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      await handlers.get(key)(record, res, n);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, seen,
    on: (path, handler) => { handlers.set(path, handler); counts.set(path, 0); },
    raw: (path, handler) => { rawHandlers.set(path, handler); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };

export async function sse(res, events, gapMs = 0) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  res.end();
}

export function testConfig(fake, extra = {}) {
  return parseConfig({
    enabled: true, clientId: "test-client", clientSecret: "test-secret", baseUrls: [fake.url],
    authUrl: `${fake.url}/auth`, tokenUrl: `${fake.url}/token`, maxRateLimitWaitMs: 5_000, ...extra,
  });
}

/** A private DSH_HOME so a test never reads or writes the operator's own files. */
export function scratchEnv() {
  const home = mkdtempSync(join(tmpdir(), "steak-dsh-ag-"));
  return { home, env: { DSH_HOME: home, PATH: process.env.PATH } };
}

export function writeConfigFile(path, object, mode = 0o600) {
  writeFileSync(path, JSON.stringify(object));
  chmodSync(path, mode);
}

export const chunk = (parts, extra = {}) => ({ response: { candidates: [{ content: { parts }, ...extra }], modelVersion: "served-1" } });
export const user = (text) => ({ role: "user", id: "u", source: { kind: "user" }, content: [{ type: "text", text }] });
export const system = (text) => ({ role: "system", id: "s", source: { kind: "system-prompt" }, content: [{ type: "text", text }] });
export async function collect(adapter, options) { const out = []; for await (const c of adapter.stream(options)) out.push(c); return out; }
export async function failure(adapter, options) { try { await collect(adapter, options); } catch (error) { return error; } throw new Error("expected the request to fail"); }
