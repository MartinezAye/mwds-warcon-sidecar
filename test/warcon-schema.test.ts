import { describe, expect, it } from "vitest";
import { parseLiveView, parseWarconEvent } from "../src/warcon/schema.js";
import { coldLiveView, killsEvent, killView, liveView, outboxEvent, serverId } from "./fixtures/warcon.js";

describe("parseWarconEvent", () => {
  it("parses a live event built from the Warcon README example", () => {
    const event = parseWarconEvent("live", JSON.stringify(liveView(Date.now())));
    expect(event.kind).toBe("live");
    if (event.kind !== "live") return;
    expect(event.view.serverId).toBe(serverId);
    expect(event.view.status?.maxPlayers).toBe(30);
    expect(event.view.status?.scores).toHaveLength(3);
    expect(event.view.players).toHaveLength(3);
    expect(event.view.players[1]?.ping).toBeNull();
  });

  it("strips fields the sidecar does not use", () => {
    const view = parseLiveView(liveView(Date.now(), { futureField: "x" }));
    expect(view).not.toBeNull();
    expect(Object.keys(view ?? {})).not.toContain("futureField");
    expect(Object.keys(view ?? {})).not.toContain("build");
  });

  it("parses a cold view with no status, as liveViewFromRow returns for an unreachable server", () => {
    const event = parseWarconEvent("live", JSON.stringify(coldLiveView()));
    expect(event.kind).toBe("live");
    if (event.kind !== "live") return;
    expect(event.view.ok).toBe(false);
    expect(event.view.status).toBeNull();
  });

  it("parses a slim view with an empty player list", () => {
    const view = parseLiveView(liveView(Date.now(), { players: [] }));
    expect(view?.players).toEqual([]);
  });

  it("drops malformed players and scores but keeps the view", () => {
    const base = liveView(Date.now());
    const status = base.status as Record<string, unknown>;
    const view = parseLiveView({
      ...base,
      status: { ...status, scores: [{ name: "Valkyra", colorHex: "#D86060", score: 1 }, { colorHex: "#000000" }, "junk"] },
      players: [{ name: "Ok", steamId: "76561198100000101", faction: "Valkyra", kills: "5", deaths: 1, cash: 2, ping: 3 }, { name: "No id" }, 42],
    });
    expect(view?.players).toHaveLength(1);
    expect(view?.players[0]?.kills).toBeNull();
    expect(view?.droppedPlayers).toBe(2);
    expect(view?.status?.scores).toHaveLength(1);
    expect(view?.droppedScores).toBe(2);
  });

  it("rejects a live event without a server id", () => {
    const event = parseWarconEvent("live", JSON.stringify({ ...liveView(Date.now()), serverId: undefined }));
    expect(event).toEqual({ kind: "invalid", name: "live", reason: "shape" });
  });

  it("parses a kills event and counts invalid kills", () => {
    const event = parseWarconEvent("kills", JSON.stringify(killsEvent([killView(), killView({ killer: null, cause: null, distanceM: null }), { eventId: 1 }])));
    expect(event).toEqual({ kind: "kills", serverId, kills: 2, invalidKills: 1 });
  });

  it("parses an outbox event", () => {
    expect(parseWarconEvent("outbox", JSON.stringify(outboxEvent()))).toEqual({ kind: "outbox", serverId });
  });

  it("reports unknown event names and broken JSON", () => {
    expect(parseWarconEvent("message", "{}")).toEqual({ kind: "unknown", name: "message" });
    expect(parseWarconEvent("live", "{nope")).toEqual({ kind: "invalid", name: "live", reason: "json" });
    expect(parseWarconEvent("kills", JSON.stringify({ type: "kills" }))).toEqual({ kind: "invalid", name: "kills", reason: "shape" });
  });
});
