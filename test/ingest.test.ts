import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IngestClient, samplesBatch } from "../src/ingest.js";
import { limits } from "../src/limits.js";
import { samplesBodySchema } from "../src/schema.js";
import { openSpool, type Spool } from "../src/spool.js";
import { feedToken, jsonResponse } from "./fixtures/warcon.js";
import { sampleAt } from "./fixtures/samples.js";

const base = Date.parse("2026-10-28T12:00:00.000Z");
const endpoint = "https://ingest.example.test";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spool(now: () => number, approved = true): Spool {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mwds-ingest-"));
  dirs.push(dir);
  const opened = openSpool({ dir, maxAgeMs: 24 * 3_600_000, now });
  if (approved) opened.markApproved();
  return opened;
}

interface Call {
  url: string;
  init: RequestInit;
}

type Responder = (call: Call) => Response | Promise<Response>;

function harness(options: { responders: Responder[]; withSpool?: boolean; approved?: boolean }) {
  const clock = { now: base };
  const calls: Call[] = [];
  const logs: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const queue = [...options.responders];
  const queueSpool = options.withSpool === false ? null : spool(() => clock.now, options.approved ?? true);
  const client = new IngestClient({
    endpoint,
    token: feedToken,
    server: "srv",
    now: () => clock.now,
    random: () => 0.5,
    spool: queueSpool,
    log: (level, message, fields = {}) => logs.push({ level, message, fields }),
    fetchImpl: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error("no responder");
      return next(call);
    },
  });
  return { client, calls, logs, clock, spool: queueSpool };
}

function bodyOf(call: Call | undefined): unknown {
  const body = call?.init.body;
  return JSON.parse(typeof body === "string" ? body : "null");
}

const ok = () => jsonResponse(200, { ok: true, accepted: 1, skipped: 0, latestPluginVersion: null });
const error = (status: number, code?: string, headers: Record<string, string> = {}) => () => jsonResponse(status, code === undefined ? { message: "x" } : { error: { code } }, headers);
const networkDown = () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));

function fill(client: IngestClient, clock: { now: number }, count: number): void {
  for (let index = 0; index < count; index += 1) client.enqueueSample(sampleAt(clock.now - (count - index) * 1000));
}

describe("IngestClient posts", () => {
  it("posts a contract body with the bearer token once the batch window passes", async () => {
    const { client, calls, clock } = harness({ responders: [ok] });
    fill(client, clock, 2);
    await client.pump();
    expect(calls).toHaveLength(0);
    clock.now += limits.batchWindowMs;
    await client.pump();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${endpoint}/v1/ingest/samples`);
    expect(new Headers(call?.init.headers).get("authorization")).toBe(`Bearer ${feedToken}`);
    expect(call?.init.redirect).toBe("error");
    const body = bodyOf(call);
    const parsed = samplesBodySchema.parse(body);
    expect(parsed.source).toBe("warcon");
    expect(parsed.agent).toEqual({ name: "mwds-warcon-sidecar", version: "0.1.0" });
    expect(parsed.samples).toHaveLength(2);
    expect(client.stats.samplesPosted).toBe(2);
    expect(client.stats.samplesAccepted).toBe(1);
    expect(client.queued).toBe(0);
    expect(client.state).toBe("ok");
  });

  it("posts at once when 30 samples are queued and splits larger queues", async () => {
    const { client, calls, clock } = harness({ responders: [ok] });
    fill(client, clock, 35);
    await client.pump();
    expect(calls.map((call) => samplesBodySchema.parse(bodyOf(call)).samples.length)).toEqual([30, 5]);
  });

  it("splits a batch whose body passes the byte limit", () => {
    const heavy = { ...sampleAt(base), serverName: "s".repeat(500), players: Array.from({ length: 128 }, (_, index) => ({ steamId: `7656119${String(index).padStart(10, "0")}`, name: "n".repeat(256), faction: "f".repeat(256), kills: 1, deaths: 1, cash: 1, pingMs: 1 })) };
    const batch = samplesBatch(Array.from({ length: 30 }, () => heavy));
    expect(batch.count).toBeLessThan(30);
    expect(Buffer.byteLength(JSON.stringify(batch.payload))).toBeLessThanOrEqual(limits.maxBodyBytes);
  });
});

describe("IngestClient results", () => {
  it("holds on 401, never spools, keeps the existing queue and logs the token problem", async () => {
    const { client, clock, logs, spool: queue } = harness({ responders: [error(401, "unauthorized")] });
    queue?.append(sampleAt(base - 60_000), base - 60_000);
    fill(client, clock, 30);
    await client.pump();
    expect(client.state).toBe("unauthorized");
    expect(client.queued).toBe(30);
    expect(queue?.length).toBe(1);
    expect(client.spoolMemory()).toBe(0);
    expect(logs.at(-1)?.message).toBe("MyWardogsStats token rejected, check the feed token in the owner portal");
  });

  it("maps 403 codes like the plugin", async () => {
    for (const [code, state] of [
      ["server_suspended", "server_suspended"],
      ["forbidden", "forbidden"],
      [undefined, "forbidden"],
    ] as const) {
      const { client, clock, logs } = harness({ responders: [error(403, code)] });
      fill(client, clock, 30);
      await client.pump();
      expect(client.state).toBe(state);
      expect(client.queued).toBe(30);
      if (state === "forbidden") expect(logs.at(-1)?.message).toBe(`MyWardogsStats refused this server (403 ${code ?? "no code"})`);
    }
  });

  it("forgets approval on 403 server_not_approved and keeps only memory", async () => {
    const { client, clock, spool: queue } = harness({ responders: [error(403, "server_not_approved")] });
    fill(client, clock, 30);
    await client.pump();
    expect(client.state).toBe("server_not_approved");
    expect(client.approved).toBe(false);
    expect(queue?.isApproved()).toBe(false);
    expect(client.spoolMemory()).toBe(0);
    expect(queue?.length).toBe(0);
  });

  it("waits out retry-after on 429 and spools the batch", async () => {
    const { client, clock, calls, spool: queue } = harness({ responders: [error(429, "rate_limited", { "retry-after": "7" }), ok] });
    fill(client, clock, 30);
    await client.pump();
    expect(client.state).toBe("rate_limited");
    expect(queue?.length).toBe(30);
    expect(client.queued).toBe(0);
    clock.now += 6000;
    await client.pump();
    expect(calls).toHaveLength(1);
    clock.now += 1000;
    await client.pump();
    expect(calls).toHaveLength(2);
    expect(queue?.length).toBe(0);
    expect(queue?.stats.replayed).toBe(30);
  });

  it("backs off exponentially on 503 without retry-after, 5xx and network errors", async () => {
    for (const responder of [error(503, "overloaded"), error(500, "internal"), networkDown]) {
      const { client, clock, calls, spool: queue } = harness({ responders: [responder] });
      fill(client, clock, 30);
      await client.pump();
      expect(["overloaded", "failing"]).toContain(client.state);
      expect(queue?.length).toBe(30);
      clock.now += limits.backoffBaseMs - 1500;
      await client.pump();
      expect(calls).toHaveLength(1);
      clock.now += 1500;
      await client.pump();
      expect(calls).toHaveLength(2);
    }
  });

  it("drops a batch on 400, 413, 415 and 422", async () => {
    for (const status of [400, 413, 415, 422]) {
      const { client, clock, spool: queue } = harness({ responders: [error(status, "invalid_request")] });
      fill(client, clock, 30);
      await client.pump();
      expect(client.state).toBe("rejected");
      expect(client.stats.samplesDropped).toBe(30);
      expect(client.queued).toBe(0);
      expect(queue?.length).toBe(0);
    }
  });

  it("does not spool before the server has been approved", async () => {
    const { client, clock, spool: queue } = harness({ responders: [networkDown], approved: false });
    fill(client, clock, 30);
    await client.pump();
    expect(client.state).toBe("failing");
    expect(queue?.length).toBe(0);
    expect(client.queued).toBe(30);
  });

  it("records approval on the first accepted post", async () => {
    const { client, clock, spool: queue } = harness({ responders: [ok], approved: false });
    fill(client, clock, 30);
    await client.pump();
    expect(client.approved).toBe(true);
    expect(queue?.isApproved()).toBe(true);
  });

  it("keeps 15 minutes of samples in memory when it may not spool", () => {
    const { client, clock } = harness({ responders: [ok], withSpool: false });
    for (let index = 0; index < 100; index += 1) {
      client.enqueueSample(sampleAt(clock.now));
      clock.now += 20_000;
    }
    expect(client.queued).toBe(Math.floor(limits.bufferWindowMs / 20_000) + 1);
    expect(client.stats.samplesDropped).toBe(100 - client.queued);
  });

  it("moves memory overflow to the spool once approved", () => {
    const { client, clock, spool: queue } = harness({ responders: [ok] });
    for (let index = 0; index < 100; index += 1) client.enqueueSample(sampleAt(clock.now - (100 - index) * 1000));
    expect(client.queued).toBe(limits.bufferMaxSamples);
    expect(queue?.length).toBe(10);
  });

  it("replays the spool oldest first, behind live data", async () => {
    const { client, clock, calls, spool: queue } = harness({ responders: [ok] });
    for (let index = 0; index < 40; index += 1) queue?.append(sampleAt(base - 100_000 + index * 1000), base - 100_000 + index * 1000);
    fill(client, clock, 30);
    await client.pump();
    const firstBodies = calls.map((call) => samplesBodySchema.parse(bodyOf(call)).samples);
    expect(firstBodies[0]?.[0]?.at).toBe(sampleAt(clock.now - 30_000).at);
    expect(firstBodies[1]?.[0]?.at).toBe(sampleAt(base - 100_000).at);
    clock.now += limits.replayIntervalMs;
    await client.pump();
    const last = samplesBodySchema.parse(bodyOf(calls.at(-1))).samples;
    expect(last[0]?.at).toBe(sampleAt(base - 70_000).at);
    expect(queue?.length).toBe(0);
  });

  it("refuses to queue a sample that breaks the contract", () => {
    const { client } = harness({ responders: [ok] });
    expect(client.enqueueSample({ ...sampleAt(base), playersMax: 5000 })).toBe(false);
    expect(client.stats.samplesDropped).toBe(1);
  });
});
