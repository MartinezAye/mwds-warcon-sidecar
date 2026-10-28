import { Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { Heartbeat, isHealthy } from "../src/heartbeat.js";
import type { IngestLog } from "../src/ingest.js";
import { createLogger, type Logger } from "../src/logger.js";
import { Sidecar } from "../src/sidecar.js";
import { WarconStream } from "../src/warcon/client.js";
import { feedToken, jsonResponse, liveView, serverId, sseFrame, sseResponse, warconKey } from "./fixtures/warcon.js";
import { parseLiveView, type WarconLiveView } from "../src/warcon/schema.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture(): { logger: Logger; text: () => string; log: IngestLog } {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString("utf8"));
      done();
    },
  });
  const logger = createLogger("trace", [warconKey, feedToken], sink);
  return {
    logger,
    text: () => lines.join(""),
    log: (level, message, fields = {}) => {
      logger[level](fields, message);
    },
  };
}

function config(spoolDir: string): Config {
  return {
    warconUrl: "http://warcon:3000",
    warconApiKey: warconKey,
    ingestUrl: "https://ingest.example.test",
    sampleSeconds: 10,
    spoolDir,
    spoolMaxHours: 24,
    logLevel: "trace",
    servers: [{ warconServerId: serverId, tokenEnv: "MWDS_FEED_TOKEN", token: feedToken }],
  };
}

describe("logs never carry the Warcon key or a feed token", () => {
  it("masks secrets in messages, fields, nested values and errors", () => {
    const { logger, text } = capture();
    logger.info({ authorization: `Bearer ${feedToken}`, nested: { deeper: [`x${warconKey}y`] }, err: new Error(`failed with ${feedToken}`) }, `message ${warconKey}`);
    logger.warn(`plain ${feedToken}`);
    const out = text();
    expect(out).not.toContain(feedToken);
    expect(out).not.toContain(warconKey);
    expect(out).toContain("[redacted]");
  });

  it("keeps secrets out while the ingest client and the stream fail every way", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mwds-logs-"));
    dirs.push(dir);
    const { text, log } = capture();
    let clock = Date.now();
    const echo = (status: number) => () => jsonResponse(status, { error: { code: `echo ${feedToken}` }, token: feedToken });
    const responders = [
      () => Promise.reject(new TypeError(`fetch failed for ${feedToken}`)),
      echo(500),
      echo(400),
      echo(429),
      echo(403),
      echo(401),
      () => jsonResponse(200, { ok: true, accepted: 1, skipped: 0, latestPluginVersion: null }),
    ];
    let index = 0;
    const sidecar = new Sidecar({
      config: config(dir),
      log,
      now: () => clock,
      fetchImpl: async () => {
        const next = responders[Math.min(index, responders.length - 1)];
        index += 1;
        if (next === undefined) throw new Error("no responder");
        return next();
      },
    });
    for (let round = 0; round < responders.length; round += 1) {
      sidecar.onView(parseLiveView(liveView(clock)) as WarconLiveView);
      for (let sample = 0; sample < 30; sample += 1) {
        sidecar.tick();
        clock += 10_000;
        sidecar.onView(parseLiveView(liveView(clock)) as WarconLiveView);
      }
      await sidecar.pump();
      clock += 11 * 60_000;
    }

    const controller = new AbortController();
    const streamResponses = [
      () => Promise.reject(new TypeError(`connect failed ${warconKey}`)),
      () => jsonResponse(401, { ok: false, error: { message: `bad ${warconKey}`, code: "invalid_api_key" } }),
      () => sseResponse([sseFrame("live", liveView(clock)), `event: ${warconKey}\ndata: {}\n\n`]),
    ];
    const stream = new WarconStream({
      baseUrl: "http://warcon:3000",
      apiKey: warconKey,
      serverIds: [serverId],
      log,
      onView: (view) => {
        sidecar.onView(view);
      },
      sleep: () => {
        if (streamResponses.length === 0) controller.abort();
        return Promise.resolve();
      },
      fetchImpl: async () => {
        const next = streamResponses.shift();
        if (next === undefined) throw new Error("done");
        return next();
      },
    });
    await stream.run(controller.signal);
    log("info", "Health", sidecar.health(stream));

    const out = text();
    expect(index).toBeGreaterThan(5);
    expect(out).toContain("MyWardogsStats token rejected");
    expect(out).toContain("Warcon rejected the API key");
    expect(out).toContain('"msg":"Health"');
    expect(out).not.toContain(feedToken);
    expect(out).not.toContain(warconKey);
    expect(out).not.toContain(feedToken.slice(5, 30));
  });
});

describe("healthcheck", () => {
  it("is healthy only with a fresh heartbeat", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mwds-health-"));
    dirs.push(dir);
    expect(isHealthy(dir, Date.now())).toBe(false);
    const now = Date.now();
    expect(new Heartbeat(path.join(dir, "fresh"), () => undefined, () => now).write()).toBe(true);
    expect(isHealthy(path.join(dir, "fresh"), now + 1000)).toBe(true);
    const warnings: string[] = [];
    const blocked = path.join(dir, "file");
    writeFileSync(blocked, "x");
    const broken = new Heartbeat(blocked, (message) => warnings.push(message), () => now);
    expect(broken.write()).toBe(false);
    expect(broken.write()).toBe(false);
    expect(warnings).toHaveLength(1);
    new Heartbeat(dir, () => undefined, () => now).write();
    expect(isHealthy(dir, now + 1000)).toBe(true);
    expect(isHealthy(dir, now + 10 * 60_000)).toBe(false);
  });
});
