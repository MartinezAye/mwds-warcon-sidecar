import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSpool, parseSpoolLine, spoolVersion } from "../src/spool.js";
import { sampleAt } from "./fixtures/samples.js";

const dirs: string[] = [];
const base = Date.parse("2026-10-28T12:00:00.000Z");

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mwds-spool-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Spool", () => {
  it("round trips samples oldest first and survives a restart", () => {
    const dir = tempDir();
    const now = () => base;
    const spool = openSpool({ dir, maxAgeMs: 3_600_000, now });
    for (let index = 0; index < 5; index += 1) expect(spool.append(sampleAt(base - 5000 + index * 1000), base - 5000 + index * 1000)).toBe(true);
    expect(spool.length).toBe(5);
    expect(spool.peek(2).map((sample) => sample?.at)).toEqual([sampleAt(base - 5000).at, sampleAt(base - 4000).at]);
    spool.ack(2);
    expect(spool.stats.replayed).toBe(2);

    const reopened = openSpool({ dir, maxAgeMs: 3_600_000, now });
    expect(reopened.length).toBe(3);
    expect(reopened.peek(10).map((sample) => sample?.at)).toEqual([sampleAt(base - 3000).at, sampleAt(base - 2000).at, sampleAt(base - 1000).at]);
    reopened.ack(3);
    expect(reopened.length).toBe(0);
    expect(readFileSync(path.join(dir, "samples.jsonl"), "utf8")).toBe("");
  });

  it("drops corrupt, foreign and truncated lines on load and counts them", () => {
    const dir = tempDir();
    const now = () => base;
    const spool = openSpool({ dir, maxAgeMs: 3_600_000, now });
    spool.append(sampleAt(base - 2000), base - 2000);
    const file = path.join(dir, "samples.jsonl");
    appendFileSync(file, "not json\n");
    appendFileSync(file, `${JSON.stringify({ v: spoolVersion, t: base, d: { ...sampleAt(base), extra: true } })}\n`);
    appendFileSync(file, `${JSON.stringify({ v: spoolVersion + 1, t: base, d: sampleAt(base) })}\n`);
    appendFileSync(file, `${JSON.stringify({ v: spoolVersion, t: base - 1000, d: sampleAt(base - 1000) })}\n`);
    appendFileSync(file, '{"v":1,"t":');
    const reopened = openSpool({ dir, maxAgeMs: 3_600_000, now });
    expect(reopened.length).toBe(2);
    expect(reopened.stats.corrupt).toBe(4);
    expect(reopened.peek(5).map((sample) => sample?.at)).toEqual([sampleAt(base - 2000).at, sampleAt(base - 1000).at]);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("rejects a line that fails the sample contract", () => {
    expect(parseSpoolLine(JSON.stringify({ v: spoolVersion, t: base, d: { ...sampleAt(base), players: [{ steamId: "1" }] } }))).toBeNull();
    expect(parseSpoolLine(JSON.stringify({ v: spoolVersion, t: base, d: sampleAt(base), x: 1 }))).toBeNull();
    expect(parseSpoolLine(JSON.stringify({ v: spoolVersion, t: base, d: sampleAt(base) }))?.t).toBe(base);
  });

  it("refuses to append an invalid sample", () => {
    const spool = openSpool({ dir: tempDir(), maxAgeMs: 3_600_000, now: () => base });
    expect(spool.append({ ...sampleAt(base), map: "m".repeat(300) }, base)).toBe(false);
    expect(spool.stats.dropped).toBe(1);
    expect(spool.length).toBe(0);
  });

  it("drops samples older than the age bound, oldest first", () => {
    let clock = base;
    const spool = openSpool({ dir: tempDir(), maxAgeMs: 60_000, now: () => clock });
    spool.append(sampleAt(base - 50_000), base - 50_000);
    spool.append(sampleAt(base), base);
    clock += 20_000;
    spool.enforceBounds();
    expect(spool.length).toBe(1);
    expect(spool.stats.dropped).toBe(1);
  });

  it("drops the oldest samples past the byte bound", () => {
    const spool = openSpool({ dir: tempDir(), maxAgeMs: 3_600_000, maxBytes: 1500, now: () => base });
    for (let index = 0; index < 10; index += 1) spool.append(sampleAt(base - 10_000 + index), base - 10_000 + index);
    expect(spool.pendingBytes).toBeLessThanOrEqual(1500);
    expect(spool.stats.dropped).toBeGreaterThan(0);
    expect(spool.peek(1)[0]?.at).not.toBe(sampleAt(base - 10_000).at);
  });

  it("discards the queue when the format version changes", () => {
    const dir = tempDir();
    const spool = openSpool({ dir, maxAgeMs: 3_600_000, now: () => base });
    spool.append(sampleAt(base), base);
    writeFileSync(path.join(dir, "spool.json"), JSON.stringify({ spoolVersion: 0 }));
    const messages: string[] = [];
    const reopened = openSpool({ dir, maxAgeMs: 3_600_000, now: () => base, log: (message) => messages.push(message) });
    expect(reopened.length).toBe(0);
    expect(messages).toEqual(["Outage queue format changed, discarded the old queue"]);
    expect(JSON.parse(readFileSync(path.join(dir, "spool.json"), "utf8"))).toEqual({ spoolVersion });
  });

  it("ignores a cursor that does not point at a line start", () => {
    const dir = tempDir();
    const spool = openSpool({ dir, maxAgeMs: 3_600_000, now: () => base });
    spool.append(sampleAt(base - 1000), base - 1000);
    spool.append(sampleAt(base), base);
    writeFileSync(path.join(dir, "samples.cursor.json"), JSON.stringify({ v: spoolVersion, offset: 3 }));
    expect(openSpool({ dir, maxAgeMs: 3_600_000, now: () => base }).length).toBe(2);
  });

  it("records approval in a marker file", () => {
    const dir = tempDir();
    const spool = openSpool({ dir, maxAgeMs: 3_600_000, now: () => base });
    expect(spool.isApproved()).toBe(false);
    spool.markApproved();
    expect(openSpool({ dir, maxAgeMs: 3_600_000, now: () => base }).isApproved()).toBe(true);
    spool.clearApproved();
    expect(existsSync(path.join(dir, "approved.json"))).toBe(false);
  });
});
