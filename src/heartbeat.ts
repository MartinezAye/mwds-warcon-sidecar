import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { failureReason } from "./http.js";
import { limits } from "./limits.js";
import { writeAtomic } from "./spool.js";

const heartbeatSchema = z.object({ at: z.number().int().min(0) }).strict();

export function heartbeatFile(spoolDir: string): string {
  return path.join(spoolDir, "heartbeat.json");
}

export function isHealthy(spoolDir: string, now: number): boolean {
  try {
    const parsed = heartbeatSchema.safeParse(JSON.parse(readFileSync(heartbeatFile(spoolDir), "utf8")));
    return parsed.success && now - parsed.data.at <= limits.heartbeatStaleMs;
  } catch {
    return false;
  }
}

export class Heartbeat {
  private failed = false;

  constructor(
    private readonly spoolDir: string,
    private readonly warn: (message: string, fields: Record<string, unknown>) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  write(): boolean {
    try {
      mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 });
      writeAtomic(heartbeatFile(this.spoolDir), JSON.stringify({ at: this.now() }));
      this.failed = false;
      return true;
    } catch (err) {
      if (!this.failed) this.warn("Could not write the heartbeat file, the container health check will fail", { reason: failureReason(err) });
      this.failed = true;
      return false;
    }
  }
}
