import { ConfigError, loadConfig, scrubSecretEnv, secretsOf, type Config } from "./config.js";
import { Heartbeat } from "./heartbeat.js";
import { exponential, jitter } from "./http.js";
import type { IngestLog } from "./ingest.js";
import { limits } from "./limits.js";
import { createLogger } from "./logger.js";
import { Sidecar } from "./sidecar.js";
import { agentVersion } from "./version.js";
import { abortableSleep, checkKeyScope, WarconStream, type ScopeResult, type WarconTarget } from "./warcon/client.js";

type FatalScope = Extract<ScopeResult, { kind: "fatal" }>;

const scopeMessages: Record<FatalScope["reason"], string> = {
  key_rejected: "Warcon rejected WARCON_API_KEY, check the key on the Warcon org page",
  key_forbidden: "Warcon refused WARCON_API_KEY, the organisation may be suspended",
  not_warcon: "WARCON_URL does not answer like Warcon, check the address",
  no_view: "The Warcon key holds no server.view on any server",
  extra_capabilities: "The Warcon key holds more than server.view, make a key with View only",
  missing_servers: "The Warcon key does not reach every configured server",
  extra_servers: "The Warcon key reaches servers this sidecar does not send, limit the key to the configured servers",
};

function logScopeFatal(log: IngestLog, result: FatalScope): void {
  const fields: Record<string, unknown> = { reason: result.reason };
  if (result.status !== undefined) fields.status = result.status;
  if (result.code !== undefined && result.code !== null) fields.code = result.code;
  if (result.capabilities !== undefined) fields.capabilities = result.capabilities;
  if (result.serverIds !== undefined) fields.serverIds = result.serverIds;
  log("error", scopeMessages[result.reason], fields);
}

async function waitForScope(target: WarconTarget, signal: AbortSignal, log: IngestLog): Promise<ScopeResult | null> {
  let failures = 0;
  let lastReason = "";
  while (!signal.aborted) {
    const result = await checkKeyScope(target);
    if (result.kind !== "retry") return result;
    failures += 1;
    if (result.reason !== lastReason) log("warn", "Warcon not reachable yet, retrying the key check", { reason: result.reason });
    lastReason = result.reason;
    await abortableSleep(jitter(exponential(failures, limits.warconBackoffBaseMs, 60_000), Math.random), signal);
  }
  return null;
}

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (err) {
    const boot = createLogger("info", []);
    if (err instanceof ConfigError) boot.fatal({ problems: err.problems }, "Invalid configuration, exiting");
    else boot.fatal("Could not read the configuration, exiting");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  scrubSecretEnv(config);
  const logger = createLogger(config.logLevel, secretsOf(config));
  const log: IngestLog = (level, message, fields = {}) => {
    logger[level](fields, message);
  };
  const serverIds = config.servers.map((server) => server.warconServerId);
  log("info", "Starting", {
    version: agentVersion,
    warconUrl: config.warconUrl,
    ingestUrl: config.ingestUrl,
    servers: config.servers.map((server) => ({ warconServerId: server.warconServerId, tokenEnv: server.tokenEnv })),
    sampleSeconds: config.sampleSeconds,
    spoolMaxHours: config.spoolMaxHours,
  });

  const controller = new AbortController();
  const timers: ReturnType<typeof setInterval>[] = [];
  let sidecar: Sidecar | null = null;
  let stopping = false;

  const stop = (code: number, reason: string) => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    for (const timer of timers) clearInterval(timer);
    const moved = sidecar?.spoolMemory() ?? 0;
    log(code === 0 ? "info" : "error", "Stopping", { reason, spooled: moved });
    logger.flush();
    process.exit(code);
  };
  process.once("SIGTERM", () => {
    stop(0, "SIGTERM");
  });
  process.once("SIGINT", () => {
    stop(0, "SIGINT");
  });
  process.on("unhandledRejection", () => {
    stop(1, "unhandled rejection");
  });

  const heartbeat = new Heartbeat(config.spoolDir, (message, fields) => {
    log("warn", message, fields);
  });
  heartbeat.write();
  timers.push(
    setInterval(() => {
      heartbeat.write();
    }, limits.heartbeatMs),
  );

  const target: WarconTarget = { baseUrl: config.warconUrl, apiKey: config.warconApiKey, serverIds };
  const scope = await waitForScope(target, controller.signal, log);
  if (scope === null) return;
  if (scope.kind === "fatal") {
    logScopeFatal(log, scope);
    stop(1, "Warcon key check failed");
    return;
  }
  if (scope.kind === "retry") return;
  log("info", "Warcon key scope checked", { capabilities: scope.capabilities, servers: scope.servers });

  const running = new Sidecar({ config, log });
  sidecar = running;
  let firstConnect = true;
  const stream = new WarconStream({
    ...target,
    log,
    onView: (view) => {
      running.onView(view);
    },
    beforeConnect: async () => {
      if (firstConnect) {
        firstConnect = false;
        return true;
      }
      const recheck = await checkKeyScope(target);
      if (recheck.kind !== "fatal") return true;
      logScopeFatal(log, recheck);
      return false;
    },
  });

  timers.push(
    setInterval(() => {
      running.tick();
    }, config.sampleSeconds * 1000),
    setInterval(() => {
      void running.pump();
    }, limits.pumpIntervalMs),
    setInterval(() => {
      log("info", "Health", running.health(stream));
    }, limits.healthLogMs),
  );

  await stream.run(controller.signal);
  stop(1, "Warcon key check failed");
}

void main();
