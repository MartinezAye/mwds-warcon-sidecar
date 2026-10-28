import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { buildSample, factionOf, isViewFresh } from "../src/sample.js";
import { sampleSchema } from "../src/schema.js";
import { Sidecar } from "../src/sidecar.js";
import { parseLiveView, type WarconLiveView } from "../src/warcon/schema.js";
import { feedToken, liveView, serverId, warconKey } from "./fixtures/warcon.js";

const now = Date.parse("2026-10-28T12:00:00.000Z");

function parsed(raw: Record<string, unknown>): WarconLiveView {
  const result = parseLiveView(raw);
  if (result === null) throw new Error("fixture did not parse");
  return result;
}

function view(overrides: Record<string, unknown> = {}, at = now): WarconLiveView {
  return parsed(liveView(at, overrides));
}

function statusWith(patch: Record<string, unknown>, at = now): Record<string, unknown> {
  return { ...(liveView(at).status as Record<string, unknown>), ...patch };
}

const scores = [
  { name: "Valkyra", colorHex: "#D86060", score: 1 },
  { name: "Holding", colorHex: "#ffffff", score: 0 },
];

function player(index: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: `p${index}`, steamId: `7656119${String(index).padStart(10, "0")}`, faction: null, kills: 0, deaths: 0, cash: 0, ping: null, ...patch };
}

describe("factionOf", () => {
  it("keeps a scoreboard faction", () => {
    expect(factionOf("Valkyra", scores)).toBe("Valkyra");
  });

  it("treats null, empty, NONE and WHITE as unassigned", () => {
    for (const value of [null, "", "  ", "None", "NONE", "white", "WHITE"]) expect(factionOf(value, scores)).toBeNull();
  });

  it("treats a faction coloured #FFFFFF on the scoreboard as unassigned", () => {
    expect(factionOf("Holding", scores)).toBeNull();
  });

  it("keeps a faction missing from the scoreboard, like the plugin", () => {
    expect(factionOf("Manticore", scores)).toBe("Manticore");
  });

  it("cuts long names to 64 characters", () => {
    expect(factionOf("F".repeat(80), [])).toBe("F".repeat(64));
  });
});

describe("buildSample", () => {
  it("maps the README live view to the sample contract", () => {
    const sample = buildSample(view(), new Date(now));
    expect(sample).toEqual({
      at: "2026-10-28T12:00:00.000Z",
      serverName: "Warcon Demo Server [fd3596]",
      map: "Kavkazi",
      playersMax: 30,
      factionScores: [
        { name: "Valkyra", colorHex: "#D86060", score: 73 },
        { name: "Lonestar", colorHex: "#5B95D8", score: 55 },
        { name: "Manticore", colorHex: "#7BC462", score: 62 },
      ],
      players: [
        { steamId: "76561198100000101", name: "Ghostpepper", faction: "Valkyra", kills: 5, deaths: 4, cash: 750, pingMs: 16 },
        { steamId: "76561198100000102", name: "Lowkey", faction: "Lonestar", kills: 2, deaths: 6, cash: 120, pingMs: null },
        { steamId: "76561198100000103", name: "Benchwarmer", faction: null, kills: 0, deaths: 0, cash: 0, pingMs: 40 },
      ],
    });
    expect(sampleSchema.safeParse(sample).success).toBe(true);
  });

  it("turns Warcon defaults for missing values into null", () => {
    const sample = buildSample(view({ status: statusWith({ serverName: "", map: "", maxPlayers: 0, scores: [{ name: "Valkyra", colorHex: "", score: 3 }] }) }), new Date(now));
    expect(sample.serverName).toBeNull();
    expect(sample.map).toBeNull();
    expect(sample.playersMax).toBeNull();
    expect(sample.factionScores).toEqual([{ name: "Valkyra", colorHex: null, score: 3 }]);
  });

  it("returns nulls and empty lists for a view without status", () => {
    const sample = buildSample(view({ status: null, players: [] }), new Date(now));
    expect(sample).toMatchObject({ serverName: null, map: null, playersMax: null, factionScores: [], players: [] });
  });

  it("skips bad steam ids and duplicates, caps players at 128 and scores at 8", () => {
    const players = [player(0, { steamId: "123" }), player(1), player(1, { name: "dup" }), ...Array.from({ length: 140 }, (_, index) => player(index + 2))];
    const scoreRows = Array.from({ length: 12 }, (_, index) => ({ name: `F${index}`, colorHex: "#123456", score: index }));
    const sample = buildSample(view({ status: statusWith({ scores: scoreRows }), players }), new Date(now));
    expect(sample.players).toHaveLength(128);
    expect(sample.players.some((entry) => entry.name === "dup")).toBe(false);
    expect(sample.players.some((entry) => entry.steamId === "123")).toBe(false);
    expect(sample.factionScores).toHaveLength(8);
    expect(sampleSchema.safeParse(sample).success).toBe(true);
  });

  it("nulls numbers outside the contract and cuts long names", () => {
    const sample = buildSample(
      view({ players: [player(101, { name: "N".repeat(300), faction: "Valkyra", kills: 99_000_000, deaths: 1.6, cash: 1e15, ping: 2_000_000 })] }),
      new Date(now),
    );
    expect(sample.players[0]).toEqual({ steamId: "76561190000000101", name: "N".repeat(64), faction: "Valkyra", kills: null, deaths: 2, cash: null, pingMs: null });
    expect(sampleSchema.safeParse(sample).success).toBe(true);
  });
});

describe("isViewFresh", () => {
  it("accepts a view read within 60 seconds", () => {
    expect(isViewFresh(view(), now)).toBe(true);
  });

  it("refuses a view Warcon could not read, one without status, and a stale one", () => {
    expect(isViewFresh(view({ ok: false }), now)).toBe(false);
    expect(isViewFresh(view({ status: null }), now)).toBe(false);
    expect(isViewFresh(view({ playersAt: new Date(now - 61_000).toISOString() }), now)).toBe(false);
    expect(isViewFresh(view({ statusAt: null }), now)).toBe(false);
  });
});

describe("Sidecar.tick cadence", () => {
  const config: Config = {
    warconUrl: "http://warcon:3000",
    warconApiKey: warconKey,
    ingestUrl: "https://ingest.example.test",
    sampleSeconds: 20,
    spoolDir: "/data",
    spoolMaxHours: 0,
    logLevel: "silent",
    servers: [{ warconServerId: serverId, tokenEnv: "MWDS_FEED_TOKEN", token: feedToken }],
  };

  it("samples every SAMPLE_SECONDS with players on and every 60 s when empty", () => {
    let clock = now;
    const sidecar = new Sidecar({ config, log: () => undefined, now: () => clock });
    const empty = () => view({ players: [], status: statusWith({ playerCount: 0 }, clock) }, clock);
    sidecar.onView(view({}, clock));
    expect(sidecar.tick()).toHaveLength(1);
    clock += 20_000;
    sidecar.onView(view({}, clock));
    expect(sidecar.tick()).toHaveLength(1);
    clock += 20_000;
    sidecar.onView(empty());
    expect(sidecar.tick()).toHaveLength(0);
    clock += 40_000;
    sidecar.onView(empty());
    expect(sidecar.tick()).toHaveLength(1);
  });

  it("skips a stale view and ignores servers it does not send", () => {
    let clock = now;
    const sidecar = new Sidecar({ config, log: () => undefined, now: () => clock });
    sidecar.onView(view({ serverId: "someone-else" }, clock));
    expect(sidecar.tick()).toHaveLength(0);
    sidecar.onView(view({}, clock));
    clock += 90_000;
    expect(sidecar.tick()).toHaveLength(0);
    expect(sidecar.agents.get(serverId)?.skippedStale).toBe(1);
  });
});
