import path from "node:path";
import { z } from "zod";
import { limits } from "./limits.js";

export const warconKeyPattern = /^wck_[A-Za-z0-9_-]{43}$/;
export const feedTokenPattern = /^mwds_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;
export const warconServerIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const tokenEnvNamePattern = /^MWDS_FEED_TOKEN(_[A-Z0-9_]{1,40})?$/;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export const defaultWarconUrl = "http://warcon:3000";
export const defaultIngestUrl = "https://ingest.mywardogsstats.com";
export const defaultTokenEnv = "MWDS_FEED_TOKEN";

const baseUrl = (label: string, allowHttp: (host: string) => boolean, dropSuffix: RegExp | null = null) =>
  z
    .string()
    .min(1)
    .max(200)
    .transform((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: "custom", message: `${label} is not a valid URL` });
        return z.NEVER;
      }
      const httpAllowed = url.protocol === "http:" && allowHttp(url.hostname);
      if (url.protocol !== "https:" && !httpAllowed) {
        ctx.addIssue({ code: "custom", message: `${label} must use https${label === "MWDS_INGEST_URL" ? ", or http only on 127.0.0.1 or localhost" : " or http"}` });
        return z.NEVER;
      }
      if (url.username !== "" || url.password !== "") {
        ctx.addIssue({ code: "custom", message: `${label} must not carry credentials` });
        return z.NEVER;
      }
      if (url.search !== "" || url.hash !== "") {
        ctx.addIssue({ code: "custom", message: `${label} must not carry a query or a fragment` });
        return z.NEVER;
      }
      const trimmed = url.pathname.replace(/\/+$/, "");
      return `${url.origin}${dropSuffix === null ? trimmed : trimmed.replace(dropSuffix, "")}`;
    });

export const envSchema = z
  .object({
    WARCON_URL: baseUrl("WARCON_URL", () => true).default(defaultWarconUrl),
    WARCON_API_KEY: z.string().max(64).regex(warconKeyPattern, "must be a Warcon API key (wck_ and 43 characters)"),
    WARCON_SERVER_ID: z.string().max(64).regex(warconServerIdPattern, "must be a Warcon server id").optional(),
    MWDS_FEED_TOKEN: z.string().max(128).regex(feedTokenPattern, "must be a MyWardogsStats feed token").optional(),
    MWDS_SERVERS: z.string().max(4096).optional(),
    MWDS_INGEST_URL: baseUrl("MWDS_INGEST_URL", (host) => loopbackHosts.has(host), /\/v1\/ingest$/).default(defaultIngestUrl),
    SAMPLE_SECONDS: z.coerce.number().int().min(10).max(300).default(20),
    SPOOL_DIR: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."), "must be an absolute path without ..")
      .default("/data"),
    SPOOL_MAX_HOURS: z.coerce.number().min(0).max(72).default(24),
    LOG_LEVEL: z.enum(logLevels).default("info"),
  })
  .strict();

export type Env = z.infer<typeof envSchema>;

const envKeys = Object.keys(envSchema.shape) as readonly (keyof Env)[];

export interface ServerTarget {
  readonly warconServerId: string;
  readonly tokenEnv: string;
  readonly token: string;
}

export interface Config {
  readonly warconUrl: string;
  readonly warconApiKey: string;
  readonly ingestUrl: string;
  readonly sampleSeconds: number;
  readonly spoolDir: string;
  readonly spoolMaxHours: number;
  readonly logLevel: (typeof logLevels)[number];
  readonly servers: readonly ServerTarget[];
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment: ${problems.join("; ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const serverEntrySchema = z
  .object({
    warconServerId: z.string().regex(warconServerIdPattern, "must be a Warcon server id"),
    tokenEnv: z.string().regex(tokenEnvNamePattern, "must be MWDS_FEED_TOKEN or MWDS_FEED_TOKEN_<NAME>"),
  })
  .strict();

function parseServerMap(text: string, problems: string[]): { warconServerId: string; tokenEnv: string }[] {
  const entries = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (entries.length === 0) {
    problems.push("MWDS_SERVERS: lists no servers");
    return [];
  }
  if (entries.length > limits.maxServers) {
    problems.push(`MWDS_SERVERS: at most ${limits.maxServers} servers`);
    return [];
  }
  const parsed: { warconServerId: string; tokenEnv: string }[] = [];
  entries.forEach((entry, index) => {
    const at = entry.indexOf(":");
    const candidate = at === -1 ? { warconServerId: entry, tokenEnv: "" } : { warconServerId: entry.slice(0, at), tokenEnv: entry.slice(at + 1) };
    const result = serverEntrySchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push(`MWDS_SERVERS entry ${index + 1} ${issue.path.join(".")}: ${issue.message}`);
      }
      return;
    }
    parsed.push(result.data);
  });
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const picked: Record<string, string> = {};
  for (const key of envKeys) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== "") picked[key] = value;
  }
  const result = envSchema.safeParse(picked);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`));
  }
  const data = result.data;
  const problems: string[] = [];
  let pairs: { warconServerId: string; tokenEnv: string }[];

  if (data.MWDS_SERVERS !== undefined) {
    if (data.WARCON_SERVER_ID !== undefined) problems.push("WARCON_SERVER_ID: set either WARCON_SERVER_ID or MWDS_SERVERS, not both");
    pairs = parseServerMap(data.MWDS_SERVERS, problems);
  } else if (data.WARCON_SERVER_ID !== undefined) {
    pairs = [{ warconServerId: data.WARCON_SERVER_ID, tokenEnv: defaultTokenEnv }];
  } else {
    problems.push("WARCON_SERVER_ID: required (or MWDS_SERVERS for several servers)");
    pairs = [];
  }

  const ids = new Set<string>();
  const envNames = new Set<string>();
  const tokens = new Set<string>();
  const servers: ServerTarget[] = [];
  for (const pair of pairs) {
    if (ids.has(pair.warconServerId)) {
      problems.push(`MWDS_SERVERS: server ${pair.warconServerId} is listed twice`);
      continue;
    }
    if (envNames.has(pair.tokenEnv)) {
      problems.push(`MWDS_SERVERS: ${pair.tokenEnv} is used by two servers; every server needs its own token`);
      continue;
    }
    ids.add(pair.warconServerId);
    envNames.add(pair.tokenEnv);
    const raw = (pair.tokenEnv === defaultTokenEnv ? data.MWDS_FEED_TOKEN : env[pair.tokenEnv]?.trim()) ?? "";
    if (raw === "") {
      problems.push(`${pair.tokenEnv}: required, the feed token for Warcon server ${pair.warconServerId}`);
      continue;
    }
    if (raw.length > 128 || !feedTokenPattern.test(raw)) {
      problems.push(`${pair.tokenEnv}: must be a MyWardogsStats feed token`);
      continue;
    }
    if (tokens.has(raw)) {
      problems.push(`${pair.tokenEnv}: the same token is set for two servers; every server needs its own token`);
      continue;
    }
    tokens.add(raw);
    servers.push({ warconServerId: pair.warconServerId, tokenEnv: pair.tokenEnv, token: raw });
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    warconUrl: data.WARCON_URL,
    warconApiKey: data.WARCON_API_KEY,
    ingestUrl: data.MWDS_INGEST_URL,
    sampleSeconds: data.SAMPLE_SECONDS,
    spoolDir: data.SPOOL_DIR,
    spoolMaxHours: data.SPOOL_MAX_HOURS,
    logLevel: data.LOG_LEVEL,
    servers,
  };
}

export function secretsOf(config: Config): string[] {
  return [config.warconApiKey, ...config.servers.map((server) => server.token)];
}

export function scrubSecretEnv(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  Reflect.deleteProperty(env, "WARCON_API_KEY");
  Reflect.deleteProperty(env, defaultTokenEnv);
  for (const server of config.servers) Reflect.deleteProperty(env, server.tokenEnv);
}
