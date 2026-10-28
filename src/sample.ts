import { limits } from "./limits.js";
import {
  cashLimit,
  counterMax,
  counterMin,
  pingLimit,
  playersMaxLimit,
  scoreLimit,
  steamIdPattern,
  type Sample,
  type SampleFactionScore,
  type SamplePlayer,
} from "./schema.js";
import type { WarconLiveView, WarconScore } from "./warcon/schema.js";

const noTeamFactions = new Set(["", "NONE", "WHITE"]);
const noTeamColors = new Set(["#FFFFFF"]);

export function cut(value: string | null | undefined, max: number): string | null {
  if (typeof value !== "string") return null;
  const points = Array.from(value);
  return points.length > max ? points.slice(0, max).join("") : value;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.trim() === "" ? null : value;
}

export function intInRange(value: number | null | undefined, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded < min || rounded > max ? null : rounded;
}

function scoreOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || Math.abs(value) > scoreLimit) return null;
  return value;
}

function hexOf(value: string): string {
  const text = value.trim().toUpperCase();
  return text.startsWith("#") ? text : `#${text}`;
}

export function factionOf(faction: string | null, scores: readonly WarconScore[]): string | null {
  const name = typeof faction === "string" ? faction.trim() : "";
  if (noTeamFactions.has(name.toUpperCase())) return null;
  const row = scores.find((entry) => entry.name === faction);
  const color = row !== undefined && row.colorHex !== "" ? row.colorHex : null;
  if (color !== null && noTeamColors.has(hexOf(color))) return null;
  return cut(name, limits.nameLength);
}

export function buildSample(view: WarconLiveView, at: Date): Sample {
  const status = view.status;
  const scores = status?.scores ?? [];

  const factionScores: SampleFactionScore[] = [];
  for (const row of scores) {
    if (factionScores.length >= limits.factionsPerSample) break;
    const name = nonEmpty(cut(row.name, limits.nameLength));
    if (name === null) continue;
    factionScores.push({
      name,
      colorHex: nonEmpty(cut(row.colorHex, 16)),
      score: scoreOrNull(row.score),
    });
  }

  const players: SamplePlayer[] = [];
  const seen = new Set<string>();
  for (const player of view.players) {
    if (players.length >= limits.playersPerSample) break;
    const steamId = player.steamId;
    if (!steamIdPattern.test(steamId) || seen.has(steamId)) continue;
    seen.add(steamId);
    players.push({
      steamId,
      name: cut(player.name, limits.nameLength) ?? "",
      faction: factionOf(player.faction, scores),
      kills: intInRange(player.kills, counterMin, counterMax),
      deaths: intInRange(player.deaths, counterMin, counterMax),
      cash: intInRange(player.cash, -cashLimit, cashLimit),
      pingMs: intInRange(player.ping, -pingLimit, pingLimit),
    });
  }

  const playersMax = intInRange(status?.maxPlayers, 0, playersMaxLimit);
  return {
    at: at.toISOString(),
    serverName: nonEmpty(cut(status?.serverName, limits.serverNameLength)),
    map: nonEmpty(cut(status?.map, limits.nameLength)),
    playersMax: playersMax === 0 ? null : playersMax,
    factionScores,
    players,
  };
}

function ageMs(stamp: string | null, now: number): number {
  if (stamp === null) return Number.POSITIVE_INFINITY;
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

export function isViewFresh(view: WarconLiveView, now: number): boolean {
  if (!view.ok || view.status === null) return false;
  return Math.max(ageMs(view.statusAt, now), ageMs(view.playersAt, now)) <= limits.staleViewMs;
}

export function isOccupied(view: WarconLiveView): boolean {
  return view.players.length > 0 || (view.status?.playerCount ?? 0) > 0;
}
