import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { limits } from "./limits.js";
import { sampleSchema, type Sample } from "./schema.js";

export const spoolVersion = 1;

const lineSchema = z
  .object({
    v: z.literal(spoolVersion),
    t: z.number().refine(Number.isFinite),
    d: sampleSchema,
  })
  .strict();

const cursorSchema = z.object({ v: z.literal(spoolVersion), offset: z.number().int().min(0) }).strict();
const metaSchema = z.object({ spoolVersion: z.number().int() }).strict();
const approvedSchema = z.object({ v: z.literal(spoolVersion), approved: z.literal(true) }).strict();

interface Entry {
  offset: number;
  bytes: number;
  t: number;
}

interface KeptLine {
  text: string;
  t: number;
}

let tempSequence = 0;

function tempName(file: string): string {
  tempSequence += 1;
  return `${file}.${process.pid}.${Date.now()}.${tempSequence}.tmp`;
}

export function writeAtomic(file: string, data: string | Buffer): void {
  const temp = tempName(file);
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (err) {
    removeIfPresent(temp);
    throw err;
  }
}

function restrict(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

function removeIfPresent(file: string): boolean {
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function parseSpoolLine(text: string): { t: number; d: Sample } | null {
  if (text.length === 0 || text.length > limits.spoolLineBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const result = lineSchema.safeParse(value);
  return result.success ? { t: result.data.t, d: result.data.d } : null;
}

export interface SpoolStats {
  written: number;
  replayed: number;
  dropped: number;
  corrupt: number;
}

export interface SpoolOptions {
  readonly dir: string;
  readonly maxAgeMs: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

export class Spool {
  readonly dir: string;
  readonly file: string;
  readonly cursorFile: string;
  readonly approvedFile: string;
  readonly stats: SpoolStats = { written: 0, replayed: 0, dropped: 0, corrupt: 0 };
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private entries: Entry[] = [];
  private fileSize = 0;
  private cursor = 0;

  constructor(options: SpoolOptions) {
    this.dir = options.dir;
    this.file = path.join(options.dir, "samples.jsonl");
    this.cursorFile = path.join(options.dir, "samples.cursor.json");
    this.approvedFile = path.join(options.dir, "approved.json");
    this.maxAgeMs = options.maxAgeMs;
    this.maxBytes = options.maxBytes ?? limits.spoolMaxBytes;
    this.now = options.now ?? (() => Date.now());
  }

  get length(): number {
    return this.entries.length;
  }

  get pendingBytes(): number {
    return this.fileSize - this.cursor;
  }

  isApproved(): boolean {
    return approvedSchema.safeParse(readJson(this.approvedFile)).success;
  }

  markApproved(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.approvedFile, JSON.stringify({ v: spoolVersion, approved: true }));
  }

  clearApproved(): void {
    removeIfPresent(this.approvedFile);
  }

  private readCursor(bytes: Buffer): number {
    const parsed = cursorSchema.safeParse(readJson(this.cursorFile));
    if (!parsed.success) return 0;
    const offset = parsed.data.offset;
    if (offset > bytes.length) return 0;
    if (offset > 0 && bytes[offset - 1] !== 0x0a) return 0;
    return offset;
  }

  private writeCursor(): void {
    writeAtomic(this.cursorFile, JSON.stringify({ v: spoolVersion, offset: this.cursor }));
  }

  load(): this {
    let bytes: Buffer | null;
    try {
      bytes = readFileSync(this.file);
    } catch {
      bytes = null;
    }
    this.entries = [];
    this.fileSize = 0;
    this.cursor = 0;
    if (bytes === null || bytes.length === 0) {
      removeIfPresent(this.cursorFile);
      return this;
    }
    if (bytes.length > this.maxBytes * 4) {
      this.stats.corrupt += 1;
      removeIfPresent(this.file);
      removeIfPresent(this.cursorFile);
      return this;
    }
    const start = this.readCursor(bytes);
    const kept: KeptLine[] = [];
    let corrupt = 0;
    let position = start;
    while (position < bytes.length) {
      const end = bytes.indexOf(0x0a, position);
      if (end === -1) {
        corrupt += 1;
        break;
      }
      const text = bytes.subarray(position, end).toString("utf8");
      const line = parseSpoolLine(text);
      if (line === null) corrupt += 1;
      else kept.push({ text, t: line.t });
      position = end + 1;
    }
    this.stats.corrupt += corrupt;
    if (start === 0 && corrupt === 0) {
      let offset = 0;
      for (const { text, t } of kept) {
        const size = Buffer.byteLength(text) + 1;
        this.entries.push({ offset, bytes: size, t });
        offset += size;
      }
      this.fileSize = bytes.length;
    } else {
      this.rewrite(kept);
    }
    restrict(this.file);
    this.enforceBounds();
    return this;
  }

  private rewrite(kept: readonly KeptLine[]): void {
    const body = kept.map(({ text }) => `${text}\n`).join("");
    const temp = tempName(this.file);
    writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
    this.cursor = 0;
    this.writeCursor();
    renameSync(temp, this.file);
    this.entries = [];
    let offset = 0;
    for (const { text, t } of kept) {
      const size = Buffer.byteLength(text) + 1;
      this.entries.push({ offset, bytes: size, t });
      offset += size;
    }
    this.fileSize = offset;
  }

  append(sample: Sample, t: number): boolean {
    if (!sampleSchema.safeParse(sample).success || !Number.isFinite(t)) {
      this.stats.dropped += 1;
      return false;
    }
    const text = JSON.stringify({ v: spoolVersion, t, d: sample });
    if (text.length > limits.spoolLineBytes) {
      this.stats.dropped += 1;
      return false;
    }
    const line = `${text}\n`;
    const size = Buffer.byteLength(line);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const fresh = this.fileSize === 0;
    appendFileSync(this.file, line, { mode: 0o600 });
    if (fresh) restrict(this.file);
    this.entries.push({ offset: this.fileSize, bytes: size, t });
    this.fileSize += size;
    this.stats.written += 1;
    this.enforceBounds();
    return true;
  }

  peek(count: number): (Sample | null)[] {
    const slice = this.entries.slice(0, count);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) return [];
    const from = first.offset;
    const length = last.offset + last.bytes - from;
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buffer, 0, length, from);
    } finally {
      closeSync(fd);
    }
    return slice.map((entry) => {
      const text = buffer.subarray(entry.offset - from, entry.offset - from + entry.bytes - 1).toString("utf8");
      return parseSpoolLine(text)?.d ?? null;
    });
  }

  ack(count: number, options: { dropped?: boolean; corrupt?: number } = {}): void {
    const removed = this.entries.splice(0, count).length;
    if (removed === 0) return;
    const corrupt = options.corrupt ?? 0;
    const good = removed - corrupt;
    if (options.dropped === true) this.stats.dropped += good;
    else this.stats.replayed += good;
    this.stats.corrupt += corrupt;
    this.cursor = this.entries[0]?.offset ?? this.fileSize;
    this.settle();
  }

  enforceBounds(): number {
    const cutoff = this.now() - this.maxAgeMs;
    let dropped = 0;
    for (;;) {
      const head = this.entries[0];
      if (head === undefined || (head.t >= cutoff && this.pendingBytes <= this.maxBytes)) break;
      this.entries.shift();
      this.cursor = head.offset + head.bytes;
      dropped += 1;
    }
    if (dropped === 0 && this.fileSize <= this.maxBytes) return 0;
    this.stats.dropped += dropped;
    this.settle();
    return dropped;
  }

  private settle(): void {
    if (this.entries.length === 0) {
      this.rewrite([]);
      return;
    }
    if (this.cursor * 2 > this.fileSize || this.fileSize > this.maxBytes) {
      this.compact();
      return;
    }
    this.writeCursor();
  }

  private compact(): void {
    const from = this.cursor;
    const length = this.fileSize - from;
    const buffer = Buffer.alloc(length);
    const fd = openSync(this.file, "r");
    try {
      readSync(fd, buffer, 0, length, from);
    } finally {
      closeSync(fd);
    }
    const temp = tempName(this.file);
    writeFileSync(temp, buffer, { mode: 0o600, flag: "wx" });
    this.cursor = 0;
    this.writeCursor();
    renameSync(temp, this.file);
    for (const entry of this.entries) entry.offset -= from;
    this.fileSize = length;
  }
}

export interface OpenSpoolOptions extends SpoolOptions {
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function openSpool(options: OpenSpoolOptions): Spool {
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const metaFile = path.join(options.dir, "spool.json");
  const meta = metaSchema.safeParse(readJson(metaFile));
  const version = meta.success ? meta.data.spoolVersion : null;
  if (version !== spoolVersion) {
    const removed = removeIfPresent(path.join(options.dir, "samples.jsonl"));
    removeIfPresent(path.join(options.dir, "samples.cursor.json"));
    if (removed) options.log?.("Outage queue format changed, discarded the old queue", { format: version ?? "unknown" });
    writeAtomic(metaFile, JSON.stringify({ spoolVersion }));
  }
  const spoolOptions: SpoolOptions = {
    dir: options.dir,
    maxAgeMs: options.maxAgeMs,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return new Spool(spoolOptions).load();
}
