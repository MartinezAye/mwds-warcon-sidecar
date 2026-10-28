import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, scrubSecretEnv, secretsOf } from "../src/config.js";
import { feedToken, otherFeedToken, otherServerId, serverId, warconKey } from "./fixtures/warcon.js";

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return [...err.problems];
    throw err;
  }
  return [];
}

const single = { WARCON_API_KEY: warconKey, WARCON_SERVER_ID: serverId, MWDS_FEED_TOKEN: feedToken };

describe("loadConfig", () => {
  it("reads one server with defaults", () => {
    const config = loadConfig({ ...single, UNRELATED: "x" });
    expect(config).toEqual({
      warconUrl: "http://warcon:3000",
      warconApiKey: warconKey,
      ingestUrl: "https://ingest.mywardogsstats.com",
      sampleSeconds: 20,
      spoolDir: "/data",
      spoolMaxHours: 24,
      logLevel: "info",
      servers: [{ warconServerId: serverId, tokenEnv: "MWDS_FEED_TOKEN", token: feedToken }],
    });
  });

  it("reads several servers from MWDS_SERVERS, each with its own token variable", () => {
    const config = loadConfig({
      WARCON_API_KEY: warconKey,
      MWDS_SERVERS: ` ${serverId}:MWDS_FEED_TOKEN_EU1 , ${otherServerId}:MWDS_FEED_TOKEN_EU2 `,
      MWDS_FEED_TOKEN_EU1: feedToken,
      MWDS_FEED_TOKEN_EU2: otherFeedToken,
    });
    expect(config.servers.map((server) => [server.warconServerId, server.tokenEnv])).toEqual([
      [serverId, "MWDS_FEED_TOKEN_EU1"],
      [otherServerId, "MWDS_FEED_TOKEN_EU2"],
    ]);
    expect(secretsOf(config)).toEqual([warconKey, feedToken, otherFeedToken]);
  });

  it("normalises URLs and accepts tuned values", () => {
    const config = loadConfig({ ...single, WARCON_URL: "http://warcon:3000/", MWDS_INGEST_URL: "http://127.0.0.1:4000", SAMPLE_SECONDS: "10", SPOOL_MAX_HOURS: "0", LOG_LEVEL: "debug" });
    expect(config.warconUrl).toBe("http://warcon:3000");
    expect(config.ingestUrl).toBe("http://127.0.0.1:4000");
    expect(loadConfig({ ...single, MWDS_INGEST_URL: "https://ingest.mywardogsstats.com/v1/ingest" }).ingestUrl).toBe("https://ingest.mywardogsstats.com");
    expect(config.sampleSeconds).toBe(10);
    expect(config.spoolMaxHours).toBe(0);
  });

  it("names every bad key and never echoes a value", () => {
    const badKey = `wck_${"q".repeat(10)}`;
    const badToken = `mwds_${"z".repeat(30)}`;
    const problems = problemsOf({
      WARCON_API_KEY: badKey,
      WARCON_SERVER_ID: serverId,
      MWDS_FEED_TOKEN: badToken,
      WARCON_URL: "ftp://user:pass@warcon",
      MWDS_INGEST_URL: "http://ingest.mywardogsstats.com",
      SAMPLE_SECONDS: "5",
      SPOOL_MAX_HOURS: "100",
      SPOOL_DIR: "relative/dir",
      LOG_LEVEL: "loud",
    });
    const keys = problems.map((problem) => problem.split(":")[0]);
    expect(keys).toEqual(expect.arrayContaining(["WARCON_API_KEY", "MWDS_FEED_TOKEN", "WARCON_URL", "MWDS_INGEST_URL", "SAMPLE_SECONDS", "SPOOL_MAX_HOURS", "SPOOL_DIR", "LOG_LEVEL"]));
    const text = problems.join("\n");
    expect(text).not.toContain(badKey);
    expect(text).not.toContain(badToken);
    expect(text).not.toContain("pass");
  });

  it("requires a server id and its token", () => {
    expect(problemsOf({ WARCON_API_KEY: warconKey })).toEqual(["WARCON_SERVER_ID: required (or MWDS_SERVERS for several servers)"]);
    expect(problemsOf({ WARCON_API_KEY: warconKey, WARCON_SERVER_ID: serverId })[0]).toMatch(/^MWDS_FEED_TOKEN: required/);
    expect(problemsOf({ WARCON_SERVER_ID: serverId, MWDS_FEED_TOKEN: feedToken })[0]).toMatch(/^WARCON_API_KEY/);
  });

  it("refuses ambiguous or unsafe server maps", () => {
    expect(problemsOf({ ...single, MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN` })[0]).toMatch(/not both/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:WARCON_API_KEY` })[0]).toMatch(/MWDS_FEED_TOKEN_<NAME>/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:PATH` })[0]).toMatch(/MWDS_FEED_TOKEN_<NAME>/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: serverId })[0]).toMatch(/tokenEnv/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `bad id!:MWDS_FEED_TOKEN_A` })[0]).toMatch(/warconServerId/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: " , " })[0]).toMatch(/lists no servers/);
    const seventeen = Array.from({ length: 17 }, (_, index) => `s${index}:MWDS_FEED_TOKEN_${index}`).join(",");
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: seventeen })[0]).toMatch(/at most 16/);
  });

  it("refuses duplicate servers, shared variables and shared tokens", () => {
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN_A,${serverId}:MWDS_FEED_TOKEN_B`, MWDS_FEED_TOKEN_A: feedToken, MWDS_FEED_TOKEN_B: otherFeedToken })[0]).toMatch(/listed twice/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN_A,${otherServerId}:MWDS_FEED_TOKEN_A`, MWDS_FEED_TOKEN_A: feedToken })[0]).toMatch(/used by two servers/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN_A,${otherServerId}:MWDS_FEED_TOKEN_B`, MWDS_FEED_TOKEN_A: feedToken, MWDS_FEED_TOKEN_B: feedToken })[0]).toMatch(/same token/);
    expect(problemsOf({ WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN_A`, MWDS_FEED_TOKEN_A: "short" })).toEqual(["MWDS_FEED_TOKEN_A: must be a MyWardogsStats feed token"]);
  });

  it("removes secrets from the process environment after reading them", () => {
    const env: NodeJS.ProcessEnv = { WARCON_API_KEY: warconKey, MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN_A`, MWDS_FEED_TOKEN_A: feedToken, KEEP: "1" };
    scrubSecretEnv(loadConfig(env), env);
    expect(env).toEqual({ MWDS_SERVERS: `${serverId}:MWDS_FEED_TOKEN_A`, KEEP: "1" });
  });
});
