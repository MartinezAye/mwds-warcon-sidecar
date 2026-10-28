export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export interface SseLimits {
  readonly maxEventBytes: number;
  readonly maxBufferBytes: number;
}

export class SseLimitError extends Error {
  constructor(readonly bytes: number) {
    super(`event stream line larger than allowed (${bytes} bytes or more)`);
    this.name = "SseLimitError";
  }
}

const eventNameLength = 64;

export class SseParser {
  readonly stats = { events: 0, comments: 0, oversized: 0 };
  private readonly decoder = new TextDecoder("utf-8");
  private pending = "";
  private scanFrom = 0;
  private skipLf = false;
  private eventName = "";
  private dataLines: string[] = [];
  private dataBytes = 0;
  private oversized = false;

  constructor(private readonly limits: SseLimits) {}

  push(chunk: Uint8Array): SseEvent[] {
    return this.take(this.decoder.decode(chunk, { stream: true }));
  }

  end(): SseEvent[] {
    const events = this.take(this.decoder.decode());
    this.pending = "";
    this.scanFrom = 0;
    this.resetEvent();
    return events;
  }

  private take(text: string): SseEvent[] {
    let input = text;
    if (this.skipLf && input.length > 0) {
      if (input.startsWith("\n") && this.pending === "") input = input.slice(1);
      this.skipLf = false;
    }
    this.pending += input;
    const events: SseEvent[] = [];
    let start = 0;
    let index = this.scanFrom;
    while (index < this.pending.length) {
      const char = this.pending.charCodeAt(index);
      if (char !== 0x0a && char !== 0x0d) {
        index += 1;
        continue;
      }
      const line = this.pending.slice(start, index);
      if (char === 0x0d) {
        if (index + 1 < this.pending.length) {
          if (this.pending.charCodeAt(index + 1) === 0x0a) index += 1;
        } else {
          this.skipLf = true;
        }
      }
      index += 1;
      start = index;
      const event = this.line(line);
      if (event !== null) events.push(event);
    }
    this.pending = this.pending.slice(start);
    this.scanFrom = this.pending.length;
    if (this.pending.length > this.limits.maxBufferBytes / 4) {
      const bytes = Buffer.byteLength(this.pending);
      if (bytes > this.limits.maxBufferBytes) {
        this.pending = "";
        this.scanFrom = 0;
        throw new SseLimitError(bytes);
      }
    }
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) {
      this.stats.comments += 1;
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      this.eventName = value.slice(0, eventNameLength);
    } else if (field === "data") {
      if (this.oversized) return null;
      this.dataBytes += Buffer.byteLength(value) + 1;
      if (this.dataBytes > this.limits.maxEventBytes) {
        this.oversized = true;
        this.dataLines = [];
        return null;
      }
      this.dataLines.push(value);
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    const oversized = this.oversized;
    const hasData = this.dataLines.length > 0;
    const event: SseEvent = { event: this.eventName === "" ? "message" : this.eventName, data: this.dataLines.join("\n") };
    this.resetEvent();
    if (oversized) {
      this.stats.oversized += 1;
      return null;
    }
    if (!hasData) return null;
    this.stats.events += 1;
    return event;
  }

  private resetEvent(): void {
    this.eventName = "";
    this.dataLines = [];
    this.dataBytes = 0;
    this.oversized = false;
  }
}
