import { describe, expect, it } from "vitest";
import { SseLimitError, SseParser } from "../src/sse.js";
import { liveView, sseFrame, ssePing } from "./fixtures/warcon.js";

const encoder = new TextEncoder();
const caps = { maxEventBytes: 64 * 1024, maxBufferBytes: 1024 * 1024 };

function feed(parser: SseParser, text: string, chunkSize = text.length) {
  const bytes = encoder.encode(text);
  const events = [];
  for (let start = 0; start < bytes.length; start += Math.max(1, chunkSize)) {
    events.push(...parser.push(bytes.subarray(start, start + Math.max(1, chunkSize))));
  }
  return events;
}

describe("SseParser", () => {
  it("reads Warcon frames and ping comments", () => {
    const parser = new SseParser(caps);
    const view = liveView(Date.now());
    const events = feed(parser, `${sseFrame("live", view)}${ssePing}${sseFrame("kills", { type: "kills" })}`);
    expect(events.map((event) => event.event)).toEqual(["live", "kills"]);
    expect(JSON.parse(events[0]?.data ?? "")).toEqual(view);
    expect(parser.stats.comments).toBe(1);
  });

  it("handles frames split at every byte", () => {
    const parser = new SseParser(caps);
    const text = `${sseFrame("live", { name: "Ghöstpepper ü" })}${ssePing}${sseFrame("live", { n: 2 })}`;
    const events = feed(parser, text, 1);
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]?.data ?? "")).toEqual({ name: "Ghöstpepper ü" });
  });

  it("accepts CRLF and CR line endings, also split across chunks", () => {
    const parser = new SseParser(caps);
    expect(feed(parser, "event: live\r\ndata: 1\r\n\r\nevent: live\rdata: 2\r\r", 1).map((event) => event.data)).toEqual(["1", "2"]);
  });

  it("joins multi-line data and defaults the event name", () => {
    const parser = new SseParser(caps);
    expect(feed(parser, "data: a\ndata:b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("ignores events without data, id and retry fields", () => {
    const parser = new SseParser(caps);
    expect(feed(parser, "event: live\nid: 7\nretry: 100\n\n")).toEqual([]);
  });

  it("drops an event over the per-event cap and keeps reading", () => {
    const parser = new SseParser(caps);
    const big = "x".repeat(64 * 1024 + 1);
    const events = feed(parser, `event: live\ndata: ${big}\n\n${sseFrame("live", { ok: true })}`, 4096);
    expect(events).toEqual([{ event: "live", data: '{"ok":true}' }]);
    expect(parser.stats.oversized).toBe(1);
  });

  it("drops an event whose data lines together pass the cap", () => {
    const parser = new SseParser(caps);
    const line = `data: ${"y".repeat(40 * 1024)}\n`;
    expect(feed(parser, `event: live\n${line}${line}\n`)).toEqual([]);
    expect(parser.stats.oversized).toBe(1);
  });

  it("throws when an unterminated line passes the buffer cap", () => {
    const parser = new SseParser(caps);
    const chunk = encoder.encode(`data: ${"z".repeat(256 * 1024)}`);
    expect(() => {
      for (let index = 0; index < 5; index += 1) parser.push(chunk);
    }).toThrow(SseLimitError);
  });

  it("discards an unterminated event at the end of the stream", () => {
    const parser = new SseParser(caps);
    feed(parser, "event: live\ndata: 1\n");
    expect(parser.end()).toEqual([]);
  });
});
