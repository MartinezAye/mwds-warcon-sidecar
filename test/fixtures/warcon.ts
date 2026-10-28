export const serverId = "fd359609-3d96-4e99-9963-22971c78d0d5";
export const otherServerId = "0b7d2f61-8f0e-4a51-9d55-0d3c3c1e8a10";
export const orgId = "6a0c9a52-46a3-4f6e-9f39-7a2b0f6e1c11";

export const warconKey = `wck_FAKE_TEST_KEY_${"0".repeat(29)}`;
export const feedToken = `mwds_faketestfake_FAKE_TEST_TOKEN_${"0".repeat(27)}`;
export const otherFeedToken = `mwds_faketestfake_FAKE_TEST_TOKEN_${"1".repeat(27)}`;

export function liveView(now: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const at = new Date(now - 1000).toISOString();
  return {
    serverId,
    ok: true,
    error: "",
    tier: "hot",
    build: "++Wardogs+Demo-CL-501228",
    gameServerId: "fae6015d-8dba-45c2-a792-50910fa21c12",
    startedAt: "2026-09-24T12:50:27.202Z",
    reservedSlots: 2,
    restartTimeUtc: null,
    restartTimeUtcFile: "08:00",
    matchState: { state: "MatchState.Playing", map: "Kavkazi", at },
    throttledUntil: null,
    status: {
      serverName: "Warcon Demo Server [fd3596]",
      map: "Kavkazi",
      experiences: ["Bakurani_KOTH_01"],
      lighting: "DayLateClear",
      alternator: "ZoneAlternator.Factory.Circle",
      scoreTick: 24,
      scoreTickMin: 18,
      scoreTickMax: 30,
      scoreCap: 100,
      matchSeconds: 130,
      playerCount: 13,
      maxPlayers: 30,
      scores: [
        { name: "Valkyra", colorHex: "#D86060", score: 73 },
        { name: "Lonestar", colorHex: "#5B95D8", score: 55 },
        { name: "Manticore", colorHex: "#7BC462", score: 62 },
      ],
      rotationNow: 0,
      rotationNext: 1,
    },
    players: [
      { name: "Ghostpepper", steamId: "76561198100000101", faction: "Valkyra", kills: 5, deaths: 4, cash: 750, ping: 16 },
      { name: "Lowkey", steamId: "76561198100000102", faction: "Lonestar", kills: 2, deaths: 6, cash: 120, ping: null },
      { name: "Benchwarmer", steamId: "76561198100000103", faction: null, kills: 0, deaths: 0, cash: 0, ping: 40 },
    ],
    statusAt: at,
    playersAt: at,
    observedAt: at,
    ...overrides,
  };
}

export function coldLiveView(): Record<string, unknown> {
  return {
    serverId,
    ok: false,
    error: "connect ECONNREFUSED",
    tier: "offline",
    build: "",
    gameServerId: "",
    startedAt: null,
    reservedSlots: null,
    restartTimeUtc: null,
    restartTimeUtcFile: null,
    matchState: null,
    throttledUntil: null,
    status: null,
    players: [],
    statusAt: null,
    playersAt: null,
    observedAt: null,
  };
}

export function killView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "c6f1d2a4-0e57-4d0b-8a49-4b8b1d1f3e21",
    ts: "2026-09-24T13:00:58.000Z",
    map: "Kavkazi",
    eventTime: 128.4,
    killer: { steamId: "76561198100000101", name: "Ghostpepper", faction: "Valkyra" },
    victim: { steamId: "76561198100000102", name: "Lowkey", faction: "Lonestar" },
    cause: "WEPN_029",
    distanceM: 54.2,
    headshot: true,
    suicide: false,
    teamKill: false,
    tags: ["Headshot"],
    ...overrides,
  };
}

export function killsEvent(kills: unknown[] = [killView()]): Record<string, unknown> {
  return { type: "kills", serverId, kills };
}

export function outboxEvent(): Record<string, unknown> {
  return { type: "outbox", serverId, id: 41, state: "delivered" };
}

export function serverSummary(id: string, caps: string[], manager = false): Record<string, unknown> {
  return {
    id,
    orgId,
    orgName: "Demo Org",
    name: `Server ${id.slice(0, 6)}`,
    host: "",
    port: 0,
    scheme: "http",
    notes: "",
    roleName: "API key",
    caps,
    manager,
    sortOrder: 0,
    demo: false,
    publicStatus: false,
    publicLeaderboards: false,
    publicKills: false,
    restartSchedule: null,
    allowPublicStatus: true,
    allowPublicLeaderboards: true,
  };
}

export function serversResponse(servers: Record<string, unknown>[]): Record<string, unknown> {
  return { ok: true, servers };
}

export function warconError(message: string, code?: string): Record<string, unknown> {
  return { ok: false, error: { message, ...(code === undefined ? {} : { code }) } };
}

export function sseFrame(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const ssePing = ": ping\n\n";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
