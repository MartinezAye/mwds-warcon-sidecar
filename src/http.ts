import { limits } from "./limits.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class CappedReadError extends Error {
  constructor(readonly bytes: number) {
    super(`response larger than allowed (${bytes} bytes or more)`);
    this.name = "CappedReadError";
  }
}

async function cancelQuietly(cancel: () => Promise<void>): Promise<void> {
  try {
    await cancel();
  } catch {
    return;
  }
}

export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  const body = response.body;
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (body !== null) await cancelQuietly(() => body.cancel());
    throw new CappedReadError(declared);
  }
  if (body === null) return Buffer.alloc(0);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await cancelQuietly(() => reader.cancel());
      throw new CappedReadError(total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function readJsonCapped(response: Response, maxBytes: number): Promise<unknown> {
  try {
    return JSON.parse((await readCapped(response, maxBytes)).toString("utf8"));
  } catch {
    return null;
  }
}

export async function discardBody(response: Response): Promise<void> {
  const body = response.body;
  if (body !== null) await cancelQuietly(() => body.cancel());
}

export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null || header.trim() === "") return null;
  const text = header.trim();
  let ms: number | null = null;
  if (/^\d{1,9}$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isFinite(at)) ms = at - now;
  }
  if (ms === null) return null;
  return Math.min(limits.retryAfterMaxMs, Math.max(limits.retryAfterMinMs, ms));
}

export function failureReason(err: unknown): string {
  if (err === null || typeof err !== "object") return "error";
  const record = err as { name?: unknown; code?: unknown; cause?: unknown };
  if (record.name === "TimeoutError" || record.name === "AbortError") return "timeout";
  const cause = record.cause !== null && typeof record.cause === "object" ? (record.cause as { code?: unknown }) : null;
  const code = cause?.code ?? record.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
  return typeof record.name === "string" && /^[A-Za-z]{2,40}$/.test(record.name) ? record.name : "error";
}

export function jitter(baseMs: number, random: () => number): number {
  return Math.round(baseMs * (0.8 + 0.2 * random()));
}

export function exponential(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures - 1, 20)));
}
