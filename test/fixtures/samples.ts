import type { Sample } from "../../src/schema.js";

export function sampleAt(ms: number): Sample {
  return {
    at: new Date(ms).toISOString(),
    serverName: "Warcon Demo Server",
    map: "Kavkazi",
    playersMax: 30,
    factionScores: [{ name: "Valkyra", colorHex: "#D86060", score: 1 }],
    players: [{ steamId: "76561198100000101", name: "Ghostpepper", faction: "Valkyra", kills: 1, deaths: 0, cash: 10, pingMs: 20 }],
  };
}
