import { exponential, failureReason, jitter, parseRetryAfter, readJsonCapped, type FetchLike } from "./http.js";
import { limits } from "./limits.js";
import { ingestErrorBodySchema, sampleSchema, samplesResponseSchema, type Sample, type SamplesBody } from "./schema.js";
import type { Spool } from "./spool.js";
import { agentName, agentVersion, userAgent } from "./version.js";

export type PostOutcome = "sent" | "dropped" | "held" | "retry";

export type IngestState =
  | "ok"
  | "unauthorized"
  | "server_not_approved"
  | "server_suspended"
  | "forbidden"
  | "rate_limited"
  | "overloaded"
  | "rejected"
  | "failing";

export type LogLevel = "info" | "warn" | "error";
export type IngestLog = (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;

const knownErrorCodes = new Set([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "server_not_approved",
  "server_suspended",
  "not_found",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "internal",
  "overloaded",
]);

const dropStatuses = new Set([400, 413, 415, 422]);
const heldStates = new Set<IngestState>(["unauthorized", "server_suspended", "server_not_approved", "forbidden"]);

const stateMessages: Record<IngestState, { level: LogLevel; text: (detail: string) => string }> = {
  ok: { level: "info", text: () => "Posting to MyWardogsStats" },
  unauthorized: { level: "error", text: () => "MyWardogsStats token rejected, check the feed token in the owner portal" },
  server_not_approved: { level: "warn", text: () => "Server registered but not approved yet" },
  server_suspended: { level: "error", text: () => "Server suspended by MyWardogsStats staff" },
  forbidden: { level: "error", text: (detail) => `MyWardogsStats refused this server (403 ${detail})` },
  rate_limited: { level: "warn", text: (detail) => `MyWardogsStats rate limited the sidecar, retrying after ${detail}` },
  overloaded: { level: "warn", text: (detail) => `MyWardogsStats is busy, retrying after ${detail}` },
  rejected: { level: "warn", text: (detail) => `MyWardogsStats rejected a batch (${detail}), the batch was dropped` },
  failing: { level: "warn", text: (detail) => `MyWardogsStats unreachable (${detail}), backing off` },
};

export function buildSamplesBody(samples: Sample[]): SamplesBody {
  return { source: "warcon", agent: { name: agentName, version: agentVersion }, samples };
}

function bodyBytes(body: SamplesBody): number {
  return Buffer.byteLength(JSON.stringify(body));
}

export function samplesBatch(peeked: readonly (Sample | null)[]): { payload: SamplesBody | null; count: number; corrupt: number } {
  let count = peeked.length;
  for (;;) {
    const window = peeked.slice(0, count);
    const valid = window.filter((sample): sample is Sample => sample !== null);
    const corrupt = window.length - valid.length;
    if (valid.length === 0) return { payload: null, count, corrupt };
    const payload = buildSamplesBody(valid);
    if (count <= 1 || bodyBytes(payload) <= limits.maxBodyBytes) return { payload, count, corrupt };
    count = Math.ceil(count / 2);
  }
}

interface QueuedSample {
  readonly sample: Sample;
  readonly queuedAt: number;
}

export interface IngestClientOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly server: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly log?: IngestLog;
  readonly spool?: Spool | null;
}

export interface IngestStats {
  samplesQueued: number;
  samplesPosted: number;
  samplesAccepted: number;
  samplesSkipped: number;
  samplesDropped: number;
  posts: number;
  failedPosts: number;
}

export class IngestClient {
  readonly server: string;
  readonly stats: IngestStats = {
    samplesQueued: 0,
    samplesPosted: 0,
    samplesAccepted: 0,
    samplesSkipped: 0,
    samplesDropped: 0,
    posts: 0,
    failedPosts: 0,
  };
  state: IngestState = "ok";
  approved: boolean;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logFn: IngestLog;
  private readonly spool: Spool | null;
  private samples: QueuedSample[] = [];
  private blockedUntil = 0;
  private failures = 0;
  private lastReplayAt = 0;
  private spoolFailed = false;
  private busy: Promise<void> | null = null;

  constructor(options: IngestClientOptions) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.server = options.server;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.logFn = options.log ?? (() => undefined);
    this.spool = options.spool ?? null;
    this.approved = this.spool?.isApproved() ?? false;
  }

  get queued(): number {
    return this.samples.length;
  }

  get spooled(): number {
    return this.spool?.length ?? 0;
  }

  get spoolStats(): Spool["stats"] | null {
    return this.spool?.stats ?? null;
  }

  private log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    this.logFn(level, message.split(this.token).join("***"), { server: this.server, ...fields });
  }

  enqueueSample(sample: Sample): boolean {
    if (!sampleSchema.safeParse(sample).success) {
      this.stats.samplesDropped += 1;
      return false;
    }
    this.samples.push({ sample, queuedAt: this.now() });
    this.stats.samplesQueued += 1;
    this.trimSamples();
    return true;
  }

  private trimSamples(): void {
    const oldest = this.now() - limits.bufferWindowMs;
    for (;;) {
      const head = this.samples[0];
      if (head === undefined || (this.samples.length <= limits.bufferMaxSamples && head.queuedAt >= oldest)) break;
      this.samples.shift();
      if (!this.spoolSample(head)) this.stats.samplesDropped += 1;
    }
  }

  canSpool(): boolean {
    return this.spool !== null && this.approved && !heldStates.has(this.state);
  }

  private spoolSample(entry: QueuedSample): boolean {
    if (!this.canSpool() || this.spool === null) return false;
    const at = Date.parse(entry.sample.at);
    try {
      const written = this.spool.append(entry.sample, Number.isFinite(at) ? at : entry.queuedAt);
      this.spoolFailed = false;
      return written;
    } catch (err) {
      if (!this.spoolFailed) this.log("warn", "Outage queue write failed, data is kept in memory only", { reason: failureReason(err) });
      this.spoolFailed = true;
      return false;
    }
  }

  spoolMemory(): number {
    if (!this.canSpool()) return 0;
    let moved = 0;
    for (const entry of this.samples) if (this.spoolSample(entry)) moved += 1;
    this.samples = [];
    return moved;
  }

  private samplesDue(): boolean {
    const head = this.samples[0];
    if (head === undefined) return false;
    if (this.samples.length >= limits.samplesPerPost) return true;
    return this.now() - head.queuedAt >= limits.batchWindowMs - limits.tickSlackMs;
  }

  private blocked(): boolean {
    return this.now() < this.blockedUntil;
  }

  pump(): Promise<void> {
    if (this.busy !== null) return this.busy;
    const run = this.drain().finally(() => {
      this.busy = null;
    });
    this.busy = run;
    return run;
  }

  private async drain(): Promise<void> {
    let backlog = false;
    for (;;) {
      this.trimSamples();
      if (this.blocked()) return;
      if (this.samples.length === 0 || !(backlog || this.samplesDue())) break;
      const chunk = this.samplesChunk();
      const outcome = await this.post(chunk.body);
      let release = outcome === "sent" || outcome === "dropped";
      if (outcome === "retry" && this.canSpool()) release = chunk.entries.every((entry) => this.spoolSample(entry));
      if (release) {
        const done = new Set(chunk.entries);
        this.samples = this.samples.filter((entry) => !done.has(entry));
      }
      if (outcome === "sent") this.stats.samplesPosted += chunk.entries.length;
      if (outcome === "dropped") this.stats.samplesDropped += chunk.entries.length;
      if (outcome !== "sent") return;
      backlog = true;
    }
    await this.replay();
  }

  private async replay(): Promise<void> {
    const spool = this.spool;
    if (spool === null || spool.length === 0 || this.blocked() || this.samplesDue()) return;
    if (this.now() - this.lastReplayAt < limits.replayIntervalMs) return;
    this.lastReplayAt = this.now();
    const batch = samplesBatch(spool.peek(limits.samplesPerPost));
    if (batch.payload === null) {
      spool.ack(batch.count, { dropped: true, corrupt: batch.corrupt });
      return;
    }
    const outcome = await this.post(batch.payload);
    if (outcome === "sent" || outcome === "dropped") spool.ack(batch.count, { dropped: outcome === "dropped", corrupt: batch.corrupt });
  }

  private samplesChunk(): { entries: QueuedSample[]; body: SamplesBody } {
    let count = Math.min(limits.samplesPerPost, this.samples.length);
    for (;;) {
      const entries = this.samples.slice(0, count);
      const body = buildSamplesBody(entries.map((entry) => entry.sample));
      if (count <= 1 || bodyBytes(body) <= limits.maxBodyBytes) return { entries, body };
      count = Math.ceil(count / 2);
    }
  }

  private setState(state: IngestState, detail = ""): void {
    if (state === this.state) return;
    this.state = state;
    const message = stateMessages[state];
    this.log(message.level, message.text(detail), { state });
  }

  private failExponential(state: IngestState, detail: string): void {
    this.failures += 1;
    this.stats.failedPosts += 1;
    this.blockedUntil = this.now() + jitter(exponential(this.failures, limits.backoffBaseMs, limits.backoffMaxMs), this.random);
    this.setState(state, detail);
  }

  private hold(state: IngestState, detail = ""): PostOutcome {
    this.stats.failedPosts += 1;
    this.blockedUntil = this.now() + limits.authBackoffMs;
    this.setState(state, detail);
    return "held";
  }

  private markApproved(): void {
    if (this.approved) return;
    this.approved = true;
    try {
      this.spool?.markApproved();
    } catch (err) {
      this.log("warn", "Could not record approval in the outage queue folder", { reason: failureReason(err) });
    }
  }

  private markNotApproved(): void {
    this.approved = false;
    this.spool?.clearApproved();
  }

  private async errorCode(response: Response): Promise<string | null> {
    const parsed = ingestErrorBodySchema.safeParse(await readJsonCapped(response, limits.errorBodyBytes));
    if (!parsed.success) return null;
    return knownErrorCodes.has(parsed.data.error.code) ? parsed.data.error.code : null;
  }

  async post(body: SamplesBody): Promise<PostOutcome> {
    this.stats.posts += 1;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoint}/v1/ingest/samples`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "user-agent": userAgent,
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(limits.requestTimeoutMs),
      });
    } catch (err) {
      this.failExponential("failing", failureReason(err));
      return "retry";
    }

    const status = response.status;
    if (status >= 200 && status < 300) {
      const parsed = samplesResponseSchema.safeParse(await readJsonCapped(response, limits.responseBytes));
      if (parsed.success) {
        this.stats.samplesAccepted += parsed.data.accepted;
        this.stats.samplesSkipped += parsed.data.skipped;
      }
      this.failures = 0;
      this.blockedUntil = 0;
      this.markApproved();
      this.setState("ok");
      return "sent";
    }

    const code = await this.errorCode(response);
    if (status === 401) return this.hold("unauthorized");
    if (status === 403) {
      if (code === "server_not_approved") {
        this.markNotApproved();
        return this.hold(code);
      }
      if (code === "server_suspended") return this.hold(code);
      return this.hold("forbidden", code ?? "no code");
    }
    if (status === 429 || status === 503) {
      const wait = parseRetryAfter(response.headers.get("retry-after"), this.now());
      const state: IngestState = status === 429 ? "rate_limited" : "overloaded";
      if (wait === null) {
        this.failExponential(state, "a backoff");
        return "retry";
      }
      this.stats.failedPosts += 1;
      this.blockedUntil = this.now() + wait;
      this.setState(state, `${Math.ceil(wait / 1000)}s`);
      return "retry";
    }
    if (dropStatuses.has(status)) {
      this.failExponential("rejected", `${status} ${code ?? "no code"}`);
      return "dropped";
    }
    this.failExponential("failing", `HTTP ${status}`);
    return "retry";
  }
}
