import { exponential, failureReason, jitter, readJsonCapped, type FetchLike } from "../http.js";
import { limits } from "../limits.js";
import { SseLimitError, SseParser } from "../sse.js";
import { userAgent } from "../version.js";
import { parseWarconEvent, safeWarconCode, warconErrorBodySchema, warconServersResponseSchema, type WarconLiveView } from "./schema.js";

export const viewCapability = "server.view";

export type ScopeFatalReason =
  | "key_rejected"
  | "key_forbidden"
  | "not_warcon"
  | "no_view"
  | "extra_capabilities"
  | "missing_servers"
  | "extra_servers";

export type ScopeResult =
  | { readonly kind: "ok"; readonly capabilities: readonly string[]; readonly servers: number }
  | {
      readonly kind: "fatal";
      readonly reason: ScopeFatalReason;
      readonly status?: number;
      readonly code?: string | null;
      readonly capabilities?: readonly string[];
      readonly serverIds?: readonly string[];
    }
  | { readonly kind: "retry"; readonly reason: string };

export interface WarconTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly serverIds: readonly string[];
  readonly fetchImpl?: FetchLike;
}

function headers(apiKey: string, accept: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, accept, "user-agent": userAgent };
}

async function warconCode(response: Response): Promise<string | null> {
  const parsed = warconErrorBodySchema.safeParse(await readJsonCapped(response, limits.errorBodyBytes));
  return parsed.success ? safeWarconCode(parsed.data.error.code) : null;
}

export async function checkKeyScope(target: WarconTarget): Promise<ScopeResult> {
  const fetchImpl = target.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(`${target.baseUrl}/api/servers`, {
      method: "GET",
      headers: headers(target.apiKey, "application/json"),
      redirect: "error",
      signal: AbortSignal.timeout(limits.requestTimeoutMs),
    });
  } catch (err) {
    return { kind: "retry", reason: failureReason(err) };
  }
  const status = response.status;
  if (status === 401) return { kind: "fatal", reason: "key_rejected", status, code: await warconCode(response) };
  if (status === 403) return { kind: "fatal", reason: "key_forbidden", status, code: await warconCode(response) };
  if (status === 404) return { kind: "fatal", reason: "not_warcon", status };
  if (status < 200 || status >= 300) {
    await readJsonCapped(response, limits.errorBodyBytes);
    return { kind: "retry", reason: `HTTP ${status}` };
  }
  const parsed = warconServersResponseSchema.safeParse(await readJsonCapped(response, limits.warconServersBytes));
  if (!parsed.success) return { kind: "fatal", reason: "not_warcon", status };

  const servers = parsed.data.servers;
  const capabilities = [...new Set(servers.flatMap((server) => server.caps))].sort();
  if (servers.length === 0 || !capabilities.includes(viewCapability)) return { kind: "fatal", reason: "no_view", capabilities };
  const extra = capabilities.filter((cap) => cap !== viewCapability);
  const managed = servers.some((server) => server.manager);
  const partial = servers.some((server) => !server.caps.includes(viewCapability));
  if (extra.length > 0 || managed || partial) return { kind: "fatal", reason: "extra_capabilities", capabilities };

  const reachable = new Set(servers.map((server) => server.id));
  const wanted = new Set(target.serverIds);
  const missing = target.serverIds.filter((id) => !reachable.has(id));
  if (missing.length > 0) return { kind: "fatal", reason: "missing_servers", serverIds: missing, capabilities };
  const others = [...reachable].filter((id) => !wanted.has(id));
  if (others.length > 0) return { kind: "fatal", reason: "extra_servers", serverIds: others, capabilities };
  return { kind: "ok", capabilities, servers: servers.length };
}

export type StreamState = "connecting" | "open" | "backoff" | "key_rejected" | "forbidden" | "no_servers" | "rate_limited" | "stopped";

export type StreamLog = (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

export interface WarconStreamOptions extends WarconTarget {
  readonly onView: (view: WarconLiveView) => void;
  readonly beforeConnect?: () => Promise<boolean>;
  readonly log?: StreamLog;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly idleTimeoutMs?: number;
}

export interface StreamStats {
  connects: number;
  live: number;
  kills: number;
  outbox: number;
  unknown: number;
  invalid: number;
  oversized: number;
  droppedPlayers: number;
  lastEventAt: number;
}

type AttemptResult =
  | { readonly kind: "ended" }
  | { readonly kind: "retry"; readonly state: StreamState; readonly waitMs?: number; readonly detail: string };

export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function streamUrl(baseUrl: string, serverIds: readonly string[]): string {
  const params = new URLSearchParams({ ids: serverIds.join(","), passive: "1" });
  return `${baseUrl}/api/live/events?${params.toString()}`;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

const stateMessages: Record<StreamState, string> = {
  connecting: "Connecting to the Warcon live view",
  open: "Reading the Warcon live view",
  backoff: "Warcon live view unavailable, retrying",
  key_rejected: "Warcon rejected the API key, check WARCON_API_KEY",
  forbidden: "Warcon refused the API key (organisation suspended?)",
  no_servers: "Warcon says the key sees none of the configured servers",
  rate_limited: "Warcon rate limited the sidecar, waiting",
  stopped: "Stopped reading the Warcon live view",
};

export class WarconStream {
  readonly stats: StreamStats = {
    connects: 0,
    live: 0,
    kills: 0,
    outbox: 0,
    unknown: 0,
    invalid: 0,
    oversized: 0,
    droppedPlayers: 0,
    lastEventAt: 0,
  };
  state: StreamState = "connecting";
  private failures = 0;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly logFn: StreamLog;
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: WarconStreamOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? abortableSleep;
    this.logFn = options.log ?? (() => undefined);
    this.idleTimeoutMs = options.idleTimeoutMs ?? limits.warconIdleTimeoutMs;
  }

  private setState(state: StreamState, detail = ""): void {
    if (state === this.state) return;
    this.state = state;
    const level = state === "key_rejected" || state === "forbidden" || state === "no_servers" ? "error" : state === "backoff" || state === "rate_limited" ? "warn" : "info";
    this.logFn(level, stateMessages[state], detail === "" ? { state } : { state, detail });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.options.beforeConnect !== undefined && !(await this.options.beforeConnect())) {
        this.setState("stopped");
        return;
      }
      if (isAborted(signal)) break;
      const result = await this.attempt(signal);
      if (isAborted(signal)) break;
      if (result.kind === "ended") {
        await this.sleep(limits.warconReconnectMs, signal);
        continue;
      }
      let wait = result.waitMs;
      if (wait === undefined) {
        this.failures += 1;
        wait = jitter(exponential(this.failures, limits.warconBackoffBaseMs, limits.warconBackoffMaxMs), this.random);
      }
      this.setState(result.state, result.detail);
      await this.sleep(wait, signal);
    }
    this.setState("stopped");
  }

  async attempt(outer: AbortSignal): Promise<AttemptResult> {
    const controller = new AbortController();
    let cancelBody: (() => void) | null = null;
    const abort = () => {
      controller.abort();
      cancelBody?.();
    };
    outer.addEventListener("abort", abort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const idle = { fired: false };
    const isIdle = () => idle.fired;
    const touch = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle.fired = true;
        abort();
      }, this.idleTimeoutMs);
    };
    const connectTimer = setTimeout(() => {
      controller.abort();
    }, limits.warconConnectTimeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(streamUrl(this.options.baseUrl, this.options.serverIds), {
          method: "GET",
          headers: { ...headers(this.options.apiKey, "text/event-stream"), "cache-control": "no-cache" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (err) {
        return { kind: "retry", state: "backoff", detail: failureReason(err) };
      } finally {
        clearTimeout(connectTimer);
      }
      const status = response.status;
      if (status === 401) return { kind: "retry", state: "key_rejected", waitMs: limits.warconAuthBackoffMs, detail: (await warconCode(response)) ?? "401" };
      if (status === 403) return { kind: "retry", state: "forbidden", waitMs: limits.warconAuthBackoffMs, detail: (await warconCode(response)) ?? "403" };
      if (status === 400) return { kind: "retry", state: "no_servers", waitMs: limits.warconAuthBackoffMs, detail: (await warconCode(response)) ?? "400" };
      if (status === 429) {
        await warconCode(response);
        return { kind: "retry", state: "rate_limited", waitMs: limits.warconRateLimitedMs, detail: "429" };
      }
      const type = response.headers.get("content-type") ?? "";
      if (status !== 200 || !type.toLowerCase().startsWith("text/event-stream") || response.body === null) {
        await readJsonCapped(response, limits.errorBodyBytes);
        return { kind: "retry", state: "backoff", detail: status === 200 ? "not an event stream" : `HTTP ${status}` };
      }
      this.stats.connects += 1;
      this.setState("open");
      touch();
      const parser = new SseParser({ maxEventBytes: limits.sseEventBytes, maxBufferBytes: limits.sseBufferBytes });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      cancelBody = () => {
        reader.cancel().catch(() => undefined);
      };
      try {
        for (;;) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (err) {
            if (isAborted(outer)) return { kind: "ended" };
            return { kind: "retry", state: "backoff", detail: isIdle() ? "idle" : failureReason(err) };
          }
          if (chunk.done) {
            if (isAborted(outer)) return { kind: "ended" };
            if (isIdle()) return { kind: "retry", state: "backoff", detail: "idle" };
            this.consume(parser.end(), parser);
            if (parser.stats.events + parser.stats.comments === 0) return { kind: "retry", state: "backoff", detail: "closed before any event" };
            this.failures = 0;
            return { kind: "ended" };
          }
          touch();
          this.consume(parser.push(chunk.value), parser);
        }
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        if (err instanceof SseLimitError) return { kind: "retry", state: "backoff", detail: "event stream line too large" };
        throw err;
      }
    } finally {
      clearTimeout(connectTimer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      outer.removeEventListener("abort", abort);
    }
  }

  private consume(events: readonly { event: string; data: string }[], parser: SseParser): void {
    this.stats.oversized += parser.stats.oversized;
    parser.stats.oversized = 0;
    for (const raw of events) {
      const event = parseWarconEvent(raw.event, raw.data);
      this.stats.lastEventAt = this.now();
      switch (event.kind) {
        case "live":
          this.stats.live += 1;
          this.stats.droppedPlayers += event.view.droppedPlayers;
          this.failures = 0;
          if (this.options.serverIds.includes(event.view.serverId)) this.options.onView(event.view);
          break;
        case "kills":
          this.stats.kills += 1;
          break;
        case "outbox":
          this.stats.outbox += 1;
          break;
        case "unknown":
          this.stats.unknown += 1;
          break;
        case "invalid":
          this.stats.invalid += 1;
          break;
      }
    }
  }
}
