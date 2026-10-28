import { pino, type DestinationStream, type LevelWithSilent, type Logger, type LogFn } from "pino";
import { agentName } from "./version.js";

export type { Logger };

const mask = "[redacted]";
const scrubDepth = 6;

export const redactedPaths = [
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "WARCON_API_KEY",
  "*.WARCON_API_KEY",
  "MWDS_FEED_TOKEN",
  "*.MWDS_FEED_TOKEN",
];

export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join(mask);
  }
  return out;
}

export function scrub(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (depth >= scrubDepth || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item: unknown) => scrub(item, secrets, depth + 1));
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`, secrets);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = scrub(item, secrets, depth + 1);
  return out;
}

export function createLogger(level: LevelWithSilent, secrets: readonly string[], destination?: DestinationStream): Logger {
  const held = [...secrets];
  const options = {
    name: agentName,
    level,
    redact: { paths: redactedPaths, censor: mask },
    hooks: {
      logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn) {
        const cleaned = args.map((arg: unknown) => scrub(arg, held)) as Parameters<LogFn>;
        method.apply(this, cleaned);
      },
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
