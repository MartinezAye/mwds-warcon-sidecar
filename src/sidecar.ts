import path from "node:path";
import type { Config } from "./config.js";
import { failureReason, type FetchLike } from "./http.js";
import { IngestClient, type IngestLog } from "./ingest.js";
import { limits } from "./limits.js";
import { buildSample, isOccupied, isViewFresh } from "./sample.js";
import type { Sample } from "./schema.js";
import { openSpool, type Spool } from "./spool.js";
import type { WarconStream } from "./warcon/client.js";
import type { WarconLiveView } from "./warcon/schema.js";

export interface ServerAgent {
  readonly warconServerId: string;
  readonly client: IngestClient;
  latest: WarconLiveView | null;
  latestAt: number;
  lastSampleAt: number | null;
  skippedStale: number;
}

export interface SidecarOptions {
  readonly config: Config;
  readonly log: IngestLog;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

export class Sidecar {
  readonly agents: ReadonlyMap<string, ServerAgent>;
  private readonly config: Config;
  private readonly log: IngestLog;
  private readonly now: () => number;

  constructor(options: SidecarOptions) {
    this.config = options.config;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
    const agents = new Map<string, ServerAgent>();
    for (const server of options.config.servers) {
      const spool = this.openQueue(server.warconServerId);
      const client = new IngestClient({
        endpoint: options.config.ingestUrl,
        token: server.token,
        server: server.warconServerId,
        now: this.now,
        log: options.log,
        spool,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      agents.set(server.warconServerId, { warconServerId: server.warconServerId, client, latest: null, latestAt: 0, lastSampleAt: null, skippedStale: 0 });
    }
    this.agents = agents;
  }

  private openQueue(warconServerId: string): Spool | null {
    if (this.config.spoolMaxHours === 0) return null;
    try {
      const spool = openSpool({
        dir: path.join(this.config.spoolDir, "servers", warconServerId),
        maxAgeMs: this.config.spoolMaxHours * 3_600_000,
        now: this.now,
        log: (message, fields) => {
          this.log("warn", message, { server: warconServerId, ...fields });
        },
      });
      if (spool.length > 0) this.log("info", "Outage queue holds samples to replay", { server: warconServerId, samples: spool.length });
      if (spool.stats.corrupt > 0) this.log("warn", "Outage queue dropped unreadable lines", { server: warconServerId, lines: spool.stats.corrupt });
      return spool;
    } catch (err) {
      this.log("warn", "Outage queue unavailable, data is kept in memory only", { server: warconServerId, reason: failureReason(err) });
      return null;
    }
  }

  onView(view: WarconLiveView): void {
    const agent = this.agents.get(view.serverId);
    if (agent === undefined) return;
    agent.latest = view;
    agent.latestAt = this.now();
  }

  tick(): Sample[] {
    const now = this.now();
    const built: Sample[] = [];
    const occupiedMs = this.config.sampleSeconds * 1000;
    for (const agent of this.agents.values()) {
      const view = agent.latest;
      if (view === null) continue;
      if (!isViewFresh(view, now)) {
        agent.skippedStale += 1;
        continue;
      }
      const interval = isOccupied(view) ? occupiedMs : Math.max(limits.emptyIntervalMs, occupiedMs);
      if (agent.lastSampleAt !== null && now - agent.lastSampleAt < interval - limits.tickSlackMs) continue;
      agent.lastSampleAt = now;
      const sample = buildSample(view, new Date(now));
      if (agent.client.enqueueSample(sample)) built.push(sample);
    }
    return built;
  }

  async pump(): Promise<void> {
    await Promise.all(
      [...this.agents.values()].map((agent) =>
        agent.client.pump().catch((err: unknown) => {
          this.log("error", "Post loop failed", { server: agent.warconServerId, reason: failureReason(err) });
        }),
      ),
    );
  }

  spoolMemory(): number {
    let moved = 0;
    for (const agent of this.agents.values()) moved += agent.client.spoolMemory();
    return moved;
  }

  health(stream: WarconStream | null): Record<string, unknown> {
    const now = this.now();
    return {
      warcon: stream === null ? null : { state: stream.state, ...stream.stats, lastEventAgoS: stream.stats.lastEventAt === 0 ? null : Math.round((now - stream.stats.lastEventAt) / 1000) },
      servers: [...this.agents.values()].map((agent) => ({
        server: agent.warconServerId,
        ingest: agent.client.state,
        approved: agent.client.approved,
        viewAgoS: agent.latestAt === 0 ? null : Math.round((now - agent.latestAt) / 1000),
        skippedStale: agent.skippedStale,
        memory: agent.client.queued,
        spooled: agent.client.spooled,
        queueDropped: agent.client.spoolStats?.dropped ?? 0,
        ...agent.client.stats,
      })),
    };
  }
}
