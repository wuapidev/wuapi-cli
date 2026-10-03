import type { StreamRuntime } from "@wuapidev/sdk";
import { describe, expect, it } from "vitest";
import { KEY, fakeIo, run, type FakeIo } from "./helpers.js";

const env = { WUAPI_API_KEY: KEY };
const STREAM = "https://stream.wuapi.dev/v1/events/stream";

const envelope = (n: number, over: Record<string, unknown> = {}) => ({
  id: `evt_${n}`,
  object: "event",
  type: "message.received",
  createdAt: "2026-09-21T06:13:20.000Z",
  organizationId: "org_acme",
  projectId: null,
  data: { object: { object: "message", id: `m_${n}`, text: `message ${n}` } },
  ...over,
});
const frame = (n: number, cursor: string) => `id: ${cursor}\nevent: message.received\ndata: ${JSON.stringify(envelope(n))}\n\n`;

/**
 * Virtual time for the stream client. A sleep never uses a real timer: once
 * everything else has settled, the earliest sleeper wakes and the clock jumps
 * to its instant, so a reconnect wait costs nothing and `time` says when each
 * connect started. The random part of a wait is a fixed draw.
 */
class AutoClock implements StreamRuntime {
  time = 0;
  #timers: { at: number; wake: () => void }[] = [];
  #pumping = false;
  constructor(private readonly draw = 0.5) {}
  now = () => this.time;
  random = () => this.draw;
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = { at: this.time + ms, wake: resolve };
      this.#timers.push(timer);
      signal.addEventListener(
        "abort",
        () => {
          this.#timers = this.#timers.filter((t) => t !== timer);
          resolve();
        },
        { once: true },
      );
      void this.#pump();
    });
  }
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
        if (this.#timers.length === 0) return;
        this.#timers.sort((a, b) => a.at - b.at);
        const next = this.#timers.shift()!;
        this.time = Math.max(this.time, next.at);
        next.wake();
      }
    } finally {
      this.#pumping = false;
    }
  }
}

interface SseCall {
  url: string;
  headers: Record<string, string>;
  /** Virtual time the connect started at. */
  at: number;
}
type SseReply = { status?: number; headers?: Record<string, string>; chunks?: string[]; hang?: boolean; body?: unknown } | Error;

/** A fetch that answers the stream URL with the replies in order (the last one repeats). */
function sseFetch(replies: SseReply[], clock: AutoClock) {
  const calls: SseCall[] = [];
  const fetch: typeof globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: input, headers, at: clock.time });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    if (reply.chunks) {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of reply.chunks!) c.enqueue(enc.encode(chunk));
          if (!reply.hang) c.close();
        },
      });
      return new Response(stream, { status, headers: { "content-type": "text/event-stream", ...reply.headers } });
    }
    return new Response(JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json", ...reply.headers } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A stream run: the fake network, the virtual clock and the io that carries both. */
function setup(replies: SseReply[], extra: Partial<FakeIo> & { env?: Record<string, string> } = {}) {
  const clock = new AutoClock();
  const { fetch, calls } = sseFetch(replies, clock);
  const io = fakeIo({ fetch, env, streamRuntime: clock, ...extra });
  return { io, clock, calls };
}

/** The seconds a "Reconnecting in Ns" line promises, in the order printed. */
const announced = (err: string) => [...err.matchAll(/Reconnecting in (\d+)s/g)].map((m) => Number(m[1]));

const lines = (out: string) => out.split("\n").filter(Boolean);

describe("wuapi events stream", () => {
  it("prints one JSON event per line: exactly the two envelopes the stream sent", async () => {
    const { io, calls } = setup([{ chunks: ["retry: 3000\n\n", frame(1, "c1.a"), frame(2, "c1.b")] }]);
    const r = await run(io, "events", "stream", "--count", "2");
    expect(r.code).toBe(0);
    const out = lines(r.out);
    expect(out).toHaveLength(2);
    expect(out.map((l) => JSON.parse(l))).toEqual([envelope(1), envelope(2)]);
    // header only, on the stream host: the key is never in the URL
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(STREAM);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers.accept).toBe("text/event-stream");
    expect(calls[0]!.headers["last-event-id"]).toBeUndefined();
    expect(calls[0]!.url).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
  });

  it("prints the frame's data as the stream sent it, not re-serialized", async () => {
    const raw = '{"id":"evt_9",  "object":"event","type":"message.received","extra":{"b":1,"a":2}}';
    const { io } = setup([{ chunks: [`id: c1.a\nevent: message.received\ndata: ${raw}\n\n`] }]);
    const r = await run(io, "events", "stream", "--count", "1");
    expect(r.out).toBe(`${raw}\n`);
  });

  it("reads a frame split across chunks and with CRLF line ends", async () => {
    const whole = frame(1, "c1.a").replace(/\n/g, "\r\n");
    const cut = Math.floor(whole.length / 2);
    const { io } = setup([{ chunks: [whole.slice(0, cut), whole.slice(cut)] }]);
    const r = await run(io, "events", "stream", "--count", "1");
    expect(lines(r.out).map((l) => JSON.parse(l))).toEqual([envelope(1)]);
  });

  it("reconnects with Last-Event-ID after the wait the contract allows, and prints each event once", async () => {
    const { io, calls } = setup([
      { chunks: ["retry: 4000\n\n", frame(1, "c1.a")] },
      // the replay repeats event 1 (at-least-once), then event 2
      { chunks: [frame(1, "c1.a"), frame(2, "c1.b")] },
    ]);
    const r = await run(io, "events", "stream", "--count", "2");
    expect(r.code).toBe(0);
    expect(lines(r.out).map((l) => JSON.parse(l).id)).toEqual(["evt_1", "evt_2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["last-event-id"]).toBe("c1.a");
    // the stream's retry (4s) is the floor; a random part of at most one backoff step comes on top
    const gap = calls[1]!.at - calls[0]!.at;
    expect(gap).toBeGreaterThanOrEqual(4000);
    expect(gap).toBeLessThan(4000 + 1000);
    expect(announced(r.err)).toEqual([Math.ceil(gap / 1000)]);
    expect(r.err).toContain("The stream ended");
  });

  it("keeps the cursor a heartbeat carries, so a quiet filtered stream resumes from a fresh one", async () => {
    const { io, calls } = setup([{ chunks: [frame(1, "c1.a"), ": ping\nid: c1.z\n\n"] }, { chunks: [frame(2, "c1.zz")] }]);
    const r = await run(io, "events", "stream", "--count", "2");
    expect(lines(r.out)).toHaveLength(2);
    expect(calls[1]!.headers["last-event-id"]).toBe("c1.z");
  });

  it("tells stderr about a reset and keeps stdout to events", async () => {
    const reset = 'event: reset\ndata: {"reason":"cursor_expired"}\n\n';
    const { io } = setup([{ chunks: ["retry: 3000\n\n", reset, frame(1, "c1.a")] }]);
    const r = await run(io, "events", "stream", "--last-event-id", "c1.old", "--count", "1");
    expect(r.code).toBe(0);
    expect(lines(r.out).map((l) => JSON.parse(l))).toEqual([envelope(1)]);
    expect(r.err).toContain("reset");
    expect(r.err).toContain("cursor_expired");
    expect(r.err).toContain("REST");
  });

  it("forgets the cursor after a reset: the next connect starts live", async () => {
    const reset = 'id: c1.n\nevent: reset\ndata: {"reason":"cursor_unknown"}\n\n';
    const { io, calls } = setup([{ chunks: [reset] }, { chunks: [frame(1, "c1.a")] }]);
    const r = await run(io, "events", "stream", "--last-event-id", "c1.old", "--count", "1");
    expect(r.code).toBe(0);
    expect(calls[0]!.headers["last-event-id"]).toBe("c1.old");
    expect(calls[1]!.headers["last-event-id"]).toBeUndefined();
  });

  it("says on stderr when it drops a frame that is not an event", async () => {
    const { io } = setup([{ chunks: ["event: message.received\ndata: not json\n\n", frame(1, "c1.a")] }]);
    const r = await run(io, "events", "stream", "--count", "1");
    expect(lines(r.out).map((l) => JSON.parse(l))).toEqual([envelope(1)]);
    expect(r.err).toContain("skipped");
    expect(r.err).toContain("message.received");
  });

  it("starts from the cursor given with --last-event-id", async () => {
    const { io, calls } = setup([{ chunks: [frame(1, "c1.b")] }]);
    await run(io, "events", "stream", "--last-event-id", "c1.a", "--count", "1");
    expect(calls[0]!.headers["last-event-id"]).toBe("c1.a");
  });

  it("sends the filters and the project", async () => {
    const { io, calls } = setup([{ chunks: [frame(1, "c1.a")] }]);
    await run(io, "events", "stream", "--types", "message.received,message.sent", "--accounts", "acc_1", "--project", "proj_1", "--count", "1");
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(STREAM);
    expect(url.searchParams.get("types")).toBe("message.received,message.sent");
    expect(url.searchParams.get("accounts")).toBe("acc_1");
    expect(calls[0]!.headers["wuapi-project"]).toBe("proj_1");
  });

  it("refuses more than 50 filter values before connecting", async () => {
    const { io, calls } = setup([{ chunks: [] }]);
    const many = Array.from({ length: 51 }, (_, i) => `t${i}`).join(",");
    const r = await run(io, "events", "stream", "--types", many, "--json");
    expect(r.code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("stops at once on a refusal that waiting cannot fix, with the API's error code", async () => {
    const body = { code: "unauthorized", message: "Missing or invalid API key." };
    const one = setup([{ status: 401, body }]);
    const r = await run(one.io, "events", "stream", "--json");
    expect(r.code).toBe(1);
    expect(r.json.error).toMatchObject({ code: "unauthorized", message: "Missing or invalid API key.", details: { status: 401 } });
    expect(one.calls).toHaveLength(1);

    const bad = setup([{ status: 400, body: { code: "invalid_request", message: "types must not name a presence event." } }]);
    const r2 = await run(bad.io, "events", "stream", "--types", "chat.presence_updated", "--json");
    expect(r2.code).toBe(1);
    expect(r2.json.error.code).toBe("invalid_request");
    expect(r2.json.error.details.status).toBe(400);
    expect(bad.calls).toHaveLength(1);
  });

  it("stops without --json too: the message on stderr, no event on stdout, exit 1", async () => {
    const { io, calls } = setup([{ status: 403, body: { code: "forbidden", message: "This key cannot open a stream." } }]);
    const r = await run(io, "events", "stream");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("This key cannot open a stream.");
    expect(calls).toHaveLength(1);
  });

  it("waits what a 429 or 503 asks (Retry-After) and tries again", async () => {
    const limit = { code: "stream_connection_limit", message: "This organization has reached its limit of open stream connections. Close one and reconnect." };
    const { io, calls } = setup([
      { status: 429, headers: { "retry-after": "30" }, body: limit },
      { status: 503, headers: { "retry-after": "5" }, body: { code: "service_unavailable", message: "The event stream is temporarily unavailable. Retry shortly." } },
      { chunks: [frame(1, "c1.a")] },
    ]);
    const r = await run(io, "events", "stream", "--count", "1");
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(3);
    // each wait is at least what the server asked for, plus at most one backoff step (1s, then 2s)
    const first = calls[1]!.at - calls[0]!.at;
    const second = calls[2]!.at - calls[1]!.at;
    expect(first).toBeGreaterThanOrEqual(30_000);
    expect(first).toBeLessThan(31_000);
    expect(second).toBeGreaterThanOrEqual(5_000);
    expect(second).toBeLessThan(7_000);
    expect(r.err).toContain("stream_connection_limit");
    expect(announced(r.err)).toEqual([Math.ceil(first / 1000), Math.ceil(second / 1000)]);
    expect(lines(r.out)).toHaveLength(1);
  });

  it("waits a minute on a 429 without a Retry-After", async () => {
    const { io, calls } = setup([{ status: 429, body: { code: "rate_limited", message: "Slow down." } }, { chunks: [frame(1, "c1.a")] }]);
    const r = await run(io, "events", "stream", "--count", "1");
    expect(r.code).toBe(0);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(60_000);
  });

  it("reconnects after a network error", async () => {
    const { io, calls } = setup([new Error("socket hang up"), { chunks: [frame(1, "c1.a")] }]);
    const r = await run(io, "events", "stream", "--count", "1");
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(3_000);
    expect(r.err).toContain("socket hang up");
    expect(announced(r.err)).toHaveLength(1);
  });

  it("reconnects when the stream goes silent for too long", async () => {
    const { io, calls } = setup([{ chunks: [frame(1, "c1.a")], hang: true }, { chunks: [frame(2, "c1.b")] }]);
    const r = await run(io, "events", "stream", "--count", "2");
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["last-event-id"]).toBe("c1.a");
    // 45s of silence (three missed heartbeats), then the wait
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(45_000);
    expect(r.err).toContain("silent");
  });

  it("paces connects: no more than six in a minute, however fast the stream keeps ending", async () => {
    const ends = Array.from({ length: 7 }, () => ({ chunks: [] as string[] }));
    const { io, calls } = setup([...ends, { status: 401, body: { code: "unauthorized", message: "Missing or invalid API key." } }]);
    const r = await run(io, "events", "stream", "--json");
    expect(r.code).toBe(1);
    expect(calls).toHaveLength(8);
    const start = calls[0]!.at;
    expect(calls.slice(0, 6).every((c) => c.at - start < 60_000)).toBe(true);
    expect(calls[6]!.at - start).toBeGreaterThanOrEqual(60_000);
  });

  it("needs a login, takes only stream arguments and refuses a key sent in clear text", async () => {
    const none = await run(fakeIo({ fetch: setup([{ chunks: [] }]).io.fetch }), "events", "stream", "--json");
    expect(none.code).toBe(1);
    expect(none.json.error.code).toBe("not_logged_in");

    const sub = await run(fakeIo({ env }), "events", "list", "--json");
    expect(sub.code).toBe(2);
    expect(sub.json.error.code).toBe("usage");
    const flag = await run(fakeIo({ env }), "events", "stream", "--bogus", "1", "--json");
    expect(flag.code).toBe(2);

    const http = await run(fakeIo({ env }), "events", "stream", "--stream-url", "http://stream.example.test", "--json");
    expect(http.code).toBe(2);
    expect(http.json.error.message).toContain("https");

    const query = await run(fakeIo({ env }), "events", "stream", "--stream-url", "https://stream.example.test/?x=1", "--json");
    expect(query.code).toBe(2);
    expect(query.json.error.code).toBe("usage");
  });

  it("can point at another stream host", async () => {
    const { io, calls } = setup([{ chunks: [frame(1, "c1.a")] }], { env: { ...env, WUAPI_STREAM_URL: "http://localhost:8080/" } });
    await run(io, "events", "stream", "--count", "1");
    expect(calls[0]!.url).toBe("http://localhost:8080/v1/events/stream");
  });

  it("never sends a key meant for another API host to the production stream", async () => {
    const { io, calls } = setup([{ chunks: [frame(1, "c1.a")] }]);
    await run(io, "events", "stream", "--base-url", "https://api.staging.example.test", "--count", "1");
    expect(new URL(calls[0]!.url).origin).toBe("https://api.staging.example.test");
  });

  it("is in the help", async () => {
    const io = fakeIo({ env });
    expect((await run(io, "help")).out).toContain("events stream");
    const h = await run(io, "events", "stream", "--help");
    expect(h.out).toContain("Last-Event-ID");
    expect(h.out).toContain("one JSON event per line");
    expect(h.out).toContain("Streams");
    // the guaranteed resume window is 28 minutes
    expect(h.out).toContain("28 minutes");
    expect(h.out).not.toContain("30 minutes");
  });
});
