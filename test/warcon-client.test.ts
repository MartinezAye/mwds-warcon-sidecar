import { describe, expect, it } from "vitest";
import { limits } from "../src/limits.js";
import { checkKeyScope, streamUrl, WarconStream } from "../src/warcon/client.js";
import type { WarconLiveView } from "../src/warcon/schema.js";
import {
  jsonResponse,
  killsEvent,
  liveView,
  otherServerId,
  outboxEvent,
  serverId,
  serverSummary,
  serversResponse,
  sseFrame,
  ssePing,
  sseResponse,
  warconError,
  warconKey,
} from "./fixtures/warcon.js";

const baseUrl = "http://warcon:3000";

function scope(response: () => Response | Promise<Response>, serverIds = [serverId]) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    run: () =>
      checkKeyScope({
        baseUrl,
        apiKey: warconKey,
        serverIds,
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return response();
        },
      }),
  };
}

describe("checkKeyScope", () => {
  it("accepts a key holding only server.view on exactly the configured servers", async () => {
    const check = scope(() => jsonResponse(200, serversResponse([serverSummary(serverId, ["server.view"])])));
    expect(await check.run()).toEqual({ kind: "ok", capabilities: ["server.view"], servers: 1 });
    expect(check.calls[0]?.url).toBe(`${baseUrl}/api/servers`);
    expect(new Headers(check.calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${warconKey}`);
    expect(check.calls[0]?.init.redirect).toBe("error");
  });

  it("refuses a key with any capability beyond server.view, listing what it found", async () => {
    const result = await scope(() => jsonResponse(200, serversResponse([serverSummary(serverId, ["server.view", "chat.send", "rcon.raw"])]))).run();
    expect(result).toEqual({ kind: "fatal", reason: "extra_capabilities", capabilities: ["chat.send", "rcon.raw", "server.view"] });
  });

  it("refuses a manager answer", async () => {
    const result = await scope(() => jsonResponse(200, serversResponse([serverSummary(serverId, ["server.view"], true)]))).run();
    expect(result.kind === "fatal" && result.reason).toBe("extra_capabilities");
  });

  it("refuses a key without view, one missing a server, and one reaching extra servers", async () => {
    expect(await scope(() => jsonResponse(200, serversResponse([]))).run()).toMatchObject({ kind: "fatal", reason: "no_view" });
    expect(await scope(() => jsonResponse(200, serversResponse([serverSummary(otherServerId, ["server.view"])])), [serverId, otherServerId]).run()).toMatchObject({
      kind: "fatal",
      reason: "missing_servers",
      serverIds: [serverId],
    });
    expect(await scope(() => jsonResponse(200, serversResponse([serverSummary(serverId, ["server.view"]), serverSummary(otherServerId, ["server.view"])]))).run()).toMatchObject({
      kind: "fatal",
      reason: "extra_servers",
      serverIds: [otherServerId],
    });
  });

  it("maps Warcon 401 and 403 answers to fatal results with the error code", async () => {
    expect(await scope(() => jsonResponse(401, warconError("This API key has been revoked.", "api_key_revoked"))).run()).toEqual({
      kind: "fatal",
      reason: "key_rejected",
      status: 401,
      code: "api_key_revoked",
    });
    expect(await scope(() => jsonResponse(403, warconError("Demo Org is suspended.", "suspended"))).run()).toEqual({ kind: "fatal", reason: "key_forbidden", status: 403, code: "suspended" });
  });

  it("treats a 404 or a non-Warcon answer as a wrong WARCON_URL", async () => {
    expect(await scope(() => new Response("<html>", { status: 404 })).run()).toMatchObject({ kind: "fatal", reason: "not_warcon" });
    expect(await scope(() => new Response("<html>", { status: 200 })).run()).toMatchObject({ kind: "fatal", reason: "not_warcon" });
  });

  it("retries on 5xx, 429 and network errors", async () => {
    expect(await scope(() => jsonResponse(503, warconError("Server restarting; retry shortly."))).run()).toEqual({ kind: "retry", reason: "HTTP 503" });
    expect(await scope(() => jsonResponse(429, warconError("Slow down.", "rate_limited"))).run()).toEqual({ kind: "retry", reason: "HTTP 429" });
    expect(await scope(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).run()).toEqual({ kind: "retry", reason: "ECONNREFUSED" });
  });
});

function streamHarness(responses: (() => Response | Promise<Response>)[], idleTimeoutMs?: number) {
  const views: WarconLiveView[] = [];
  const sleeps: number[] = [];
  const urls: string[] = [];
  const controller = new AbortController();
  const queue = [...responses];
  const stream = new WarconStream({
    baseUrl,
    apiKey: warconKey,
    serverIds: [serverId],
    random: () => 0.5,
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    onView: (view) => views.push(view),
    sleep: (ms) => {
      sleeps.push(ms);
      if (queue.length === 0) controller.abort();
      return Promise.resolve();
    },
    fetchImpl: async (url, init) => {
      urls.push(url);
      const next = queue.shift();
      if (next === undefined) throw new Error("no response");
      const response = await next();
      if (init.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      return response;
    },
  });
  return { stream, views, sleeps, urls, controller };
}

describe("WarconStream", () => {
  it("builds a passive stream URL for the configured servers", () => {
    expect(streamUrl(baseUrl, [serverId, otherServerId])).toBe(`${baseUrl}/api/live/events?ids=${serverId}%2C${otherServerId}&passive=1`);
  });

  it("delivers live views, counts other frames and reconnects after Warcon ends the stream", async () => {
    const now = Date.now();
    const frames = [
      sseFrame("live", liveView(now)),
      ssePing,
      sseFrame("kills", killsEvent()),
      sseFrame("outbox", outboxEvent()),
      sseFrame("live", liveView(now, { serverId: otherServerId })),
      sseFrame("mystery", {}),
      "event: live\ndata: {broken\n\n",
    ];
    const { stream, views, sleeps, controller } = streamHarness([() => sseResponse(frames)]);
    await stream.run(controller.signal);
    expect(views.map((view) => view.serverId)).toEqual([serverId]);
    expect(stream.stats).toMatchObject({ connects: 1, live: 2, kills: 1, outbox: 1, unknown: 1, invalid: 1 });
    expect(sleeps).toEqual([limits.warconReconnectMs]);
    expect(stream.state).toBe("stopped");
  });

  it("waits 10 minutes after Warcon rejects the key and 60 s after a 429", async () => {
    const rejected = streamHarness([() => jsonResponse(401, warconError("Unknown API key.", "invalid_api_key"))]);
    await rejected.stream.run(rejected.controller.signal);
    expect(rejected.sleeps).toEqual([limits.warconAuthBackoffMs]);
    const limited = streamHarness([() => jsonResponse(429, warconError("Slow down.", "rate_limited"))]);
    await limited.stream.run(limited.controller.signal);
    expect(limited.sleeps).toEqual([limits.warconRateLimitedMs]);
  });

  it("backs off exponentially on network errors, 5xx and a stream that closes before any frame", async () => {
    const { stream, sleeps, controller } = streamHarness([
      () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
      () => jsonResponse(503, warconError("Server restarting; retry shortly.")),
      () => sseResponse([]),
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    ]);
    await stream.run(controller.signal);
    expect(sleeps).toEqual([1800, 3600, 7200, 14400]);
  });

  it("drops the connection when nothing arrives within the idle timeout", async () => {
    const silent = () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const { stream, sleeps, controller } = streamHarness([silent], 20);
    await stream.run(controller.signal);
    expect(sleeps).toHaveLength(1);
    expect(stream.stats.connects).toBe(1);
  });

  it("stops before connecting when the scope recheck fails", async () => {
    const { controller } = streamHarness([]);
    const stream = new WarconStream({ baseUrl, apiKey: warconKey, serverIds: [serverId], onView: () => undefined, beforeConnect: () => Promise.resolve(false) });
    await stream.run(controller.signal);
    expect(stream.state).toBe("stopped");
  });
});
