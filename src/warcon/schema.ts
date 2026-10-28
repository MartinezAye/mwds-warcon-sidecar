import { z } from "zod";

const serverId = z.string().min(1).max(64);
const stamp = z.string().max(40).nullable().catch(null);
const numberOrNull = z.number().nullable().catch(null);

export const warconScoreSchema = z.object({
  name: z.string().max(256),
  colorHex: z.string().max(16).catch(""),
  score: numberOrNull,
});

export const warconPlayerSchema = z.object({
  name: z.string().max(1024).catch(""),
  steamId: z.string().max(64),
  faction: z.string().max(256).nullable().catch(null),
  kills: numberOrNull,
  deaths: numberOrNull,
  cash: numberOrNull,
  ping: numberOrNull,
});

export const warconStatusSchema = z.object({
  serverName: z.string().max(1024).catch(""),
  map: z.string().max(256).catch(""),
  playerCount: numberOrNull,
  maxPlayers: numberOrNull,
  scores: z.array(z.unknown()).max(64).catch([]),
});

export const warconLiveViewSchema = z.object({
  serverId,
  ok: z.boolean(),
  tier: z.string().max(16).catch(""),
  status: warconStatusSchema.nullable().catch(null),
  players: z.array(z.unknown()).max(1024),
  statusAt: stamp,
  playersAt: stamp,
  observedAt: stamp,
});

const killSide = z.object({
  steamId: z.string().max(64),
  name: z.string().max(1024),
  faction: z.string().max(256).nullable(),
});

export const warconKillSchema = z.object({
  eventId: z.string().max(128),
  ts: z.string().max(40),
  map: z.string().max(256),
  eventTime: z.number(),
  killer: killSide.nullable(),
  victim: killSide,
  cause: z.string().max(512).nullable(),
  distanceM: z.number().nullable(),
  headshot: z.boolean(),
  suicide: z.boolean(),
  teamKill: z.boolean(),
  tags: z.array(z.string().max(256)).max(64),
});

export const warconKillsEventSchema = z.object({
  type: z.literal("kills"),
  serverId,
  kills: z.array(z.unknown()).max(1000),
});

export const warconOutboxEventSchema = z.object({
  type: z.literal("outbox"),
  serverId,
  id: z.number().int(),
  state: z.string().max(32),
});

export const warconServerSummarySchema = z.object({
  id: serverId,
  orgId: z.string().max(64),
  name: z.string().max(512),
  caps: z.array(z.string().max(64)).max(64),
  manager: z.boolean(),
});

export const warconServersResponseSchema = z.object({
  ok: z.literal(true),
  servers: z.array(warconServerSummarySchema).max(1000),
});

export const warconErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string().max(64).optional(),
  }),
});

export type WarconScore = z.infer<typeof warconScoreSchema>;
export type WarconPlayer = z.infer<typeof warconPlayerSchema>;
export type WarconKill = z.infer<typeof warconKillSchema>;
export type WarconServerSummary = z.infer<typeof warconServerSummarySchema>;

export interface WarconStatus {
  readonly serverName: string;
  readonly map: string;
  readonly playerCount: number | null;
  readonly maxPlayers: number | null;
  readonly scores: readonly WarconScore[];
}

export interface WarconLiveView {
  readonly serverId: string;
  readonly ok: boolean;
  readonly tier: string;
  readonly status: WarconStatus | null;
  readonly players: readonly WarconPlayer[];
  readonly statusAt: string | null;
  readonly playersAt: string | null;
  readonly observedAt: string | null;
  readonly droppedPlayers: number;
  readonly droppedScores: number;
}

export type WarconEvent =
  | { readonly kind: "live"; readonly view: WarconLiveView }
  | { readonly kind: "kills"; readonly serverId: string; readonly kills: number; readonly invalidKills: number }
  | { readonly kind: "outbox"; readonly serverId: string }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "invalid"; readonly name: string; readonly reason: "json" | "shape" };

const errorCodePattern = /^[a-z][a-z0-9_]{0,39}$/;

export function safeWarconCode(code: unknown): string | null {
  return typeof code === "string" && errorCodePattern.test(code) ? code : null;
}

function keepValid<T>(rows: readonly unknown[], schema: z.ZodType<T>): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const row of rows) {
    const result = schema.safeParse(row);
    if (result.success) kept.push(result.data);
    else dropped += 1;
  }
  return { kept, dropped };
}

export function parseLiveView(value: unknown): WarconLiveView | null {
  const result = warconLiveViewSchema.safeParse(value);
  if (!result.success) return null;
  const raw = result.data;
  const players = keepValid(raw.players, warconPlayerSchema);
  const scores = keepValid(raw.status?.scores ?? [], warconScoreSchema);
  const status: WarconStatus | null =
    raw.status === null
      ? null
      : {
          serverName: raw.status.serverName,
          map: raw.status.map,
          playerCount: raw.status.playerCount,
          maxPlayers: raw.status.maxPlayers,
          scores: scores.kept,
        };
  return {
    serverId: raw.serverId,
    ok: raw.ok,
    tier: raw.tier,
    status,
    players: players.kept,
    statusAt: raw.statusAt,
    playersAt: raw.playersAt,
    observedAt: raw.observedAt,
    droppedPlayers: players.dropped,
    droppedScores: scores.dropped,
  };
}

export function parseWarconEvent(name: string, data: string): WarconEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "invalid", name, reason: "json" };
  }
  if (name === "live") {
    const view = parseLiveView(value);
    return view === null ? { kind: "invalid", name, reason: "shape" } : { kind: "live", view };
  }
  if (name === "kills") {
    const result = warconKillsEventSchema.safeParse(value);
    if (!result.success) return { kind: "invalid", name, reason: "shape" };
    const kills = keepValid(result.data.kills, warconKillSchema);
    return { kind: "kills", serverId: result.data.serverId, kills: kills.kept.length, invalidKills: kills.dropped };
  }
  if (name === "outbox") {
    const result = warconOutboxEventSchema.safeParse(value);
    return result.success ? { kind: "outbox", serverId: result.data.serverId } : { kind: "invalid", name, reason: "shape" };
  }
  return { kind: "unknown", name };
}
