import { describe, expect, it } from "vitest";
import { SseParser } from "../src/events.js";
import { KEY, fakeIo, run } from "./helpers.js";

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

interface SseCall {
  url: string;
  headers: Record<string, string>;
}
type SseReply = { status?: number; headers?: Record<string, string>; chunks?: string[]; body?: unknown } | Error;

/** A fetch that answers the stream URL with the replies in order (the last one repeats). */
function sseFetch(replies: SseReply[]) {
  const calls: SseCall[] = [];
  const fetch: typeof globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    calls.push({ url: input, headers });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    if (reply.chunks) {
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of reply.chunks!) c.enqueue(enc.encode(chunk));
          c.close();
        },
      });
      return new Response(stream, { status, headers: { "content-type": "text/event-stream", ...reply.headers } });
    }
    return new Response(JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json", ...reply.headers } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const lines = (out: string) => out.split("\n").filter(Boolean);

describe("wuapi events stream", () => {
  it("prints one JSON event per line: exactly the two envelopes the stream sent", async () => {
    const { fetch, calls } = sseFetch([{ chunks: ["retry: 3000\n\n", frame(1, "c1.a"), frame(2, "c1.b")] }]);
    const r = await run(fakeIo({ fetch, env }), "events", "stream", "--count", "2");
    expect(r.code).toBe(0);
    const out = lines(r.out);
    expect(out).toHaveLength(2);
    expect(out.map((l) => JSON.parse(l))).toEqual([envelope(1), envelope(2)]);
    // header only, on the stream host: the key is never in the URL
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(STREAM);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.headers["last-event-id"]).toBeUndefined();
    expect(calls[0]!.url).not.toContain(KEY);
  });

  it("reads a frame split across chunks and with CRLF line ends", async () => {
    const whole = frame(1, "c1.a").replace(/\n/g, "\r\n");
    const cut = Math.floor(whole.length / 2);
    const { fetch } = sseFetch([{ chunks: [whole.slice(0, cut), whole.slice(cut)] }]);
    const r = await run(fakeIo({ fetch, env }), "events", "stream", "--count", "1");
    expect(lines(r.out).map((l) => JSON.parse(l))).toEqual([envelope(1)]);
  });

  it("reconnects with Last-Event-ID after the retry time the stream gave, and prints each event once", async () => {
    const { fetch, calls } = sseFetch([
      { chunks: ["retry: 4000\n\n", frame(1, "c1.a")] },
      // the replay repeats event 1 (at-least-once), then event 2
      { chunks: [frame(1, "c1.a"), frame(2, "c1.b")] },
    ]);
    const io = fakeIo({ fetch, env });
    const r = await run(io, "events", "stream", "--count", "2");
    expect(r.code).toBe(0);
    expect(lines(r.out).map((l) => JSON.parse(l).id)).toEqual(["evt_1", "evt_2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers["last-event-id"]).toBe("c1.a");
    expect(io.sleeps).toEqual([4000]);
  });

  it("keeps the cursor a heartbeat carries, so a quiet filtered stream resumes from a fresh one", async () => {
    const { fetch, calls } = sseFetch([{ chunks: [frame(1, "c1.a"), ": ping\nid: c1.z\n\n"] }, { chunks: [frame(2, "c1.zz")] }]);
    const r = await run(fakeIo({ fetch, env }), "events", "stream", "--count", "2");
    expect(lines(r.out)).toHaveLength(2);
    expect(calls[1]!.headers["last-event-id"]).toBe("c1.z");
  });

  it("tells stderr about a reset and keeps stdout to events", async () => {
    const reset = 'event: reset\ndata: {"reason":"cursor_expired"}\n\n';
    const { fetch } = sseFetch([{ chunks: ["retry: 3000\n\n", reset, frame(1, "c1.a")] }]);
    const r = await run(fakeIo({ fetch, env }), "events", "stream", "--last-event-id", "c1.old", "--count", "1");
    expect(r.code).toBe(0);
    expect(lines(r.out).map((l) => JSON.parse(l))).toEqual([envelope(1)]);
    expect(r.err).toContain("reset");
    expect(r.err).toContain("cursor_expired");
    expect(r.err).toContain("REST");
  });

  it("starts from the cursor given with --last-event-id", async () => {
    const { fetch, calls } = sseFetch([{ chunks: [frame(1, "c1.b")] }]);
    await run(fakeIo({ fetch, env }), "events", "stream", "--last-event-id", "c1.a", "--count", "1");
    expect(calls[0]!.headers["last-event-id"]).toBe("c1.a");
  });

  it("sends the filters and the project", async () => {
    const { fetch, calls } = sseFetch([{ chunks: [frame(1, "c1.a")] }]);
    await run(fakeIo({ fetch, env }), "events", "stream", "--types", "message.received,message.sent", "--accounts", "acc_1", "--project", "proj_1", "--count", "1");
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(STREAM);
    expect(url.searchParams.get("types")).toBe("message.received,message.sent");
    expect(url.searchParams.get("accounts")).toBe("acc_1");
    expect(calls[0]!.headers["wuapi-project"]).toBe("proj_1");
  });

  it("stops at once on a refusal that waiting cannot fix, with the API's error code", async () => {
    const body = { code: "unauthorized", message: "Missing or invalid API key." };
    const { fetch, calls } = sseFetch([{ status: 401, body }]);
    const io = fakeIo({ fetch, env });
    const r = await run(io, "events", "stream", "--json");
    expect(r.code).toBe(1);
    expect(r.json.error).toMatchObject({ code: "unauthorized", message: "Missing or invalid API key." });
    expect(calls).toHaveLength(1);
    expect(io.sleeps).toEqual([]);

    const bad = sseFetch([{ status: 400, body: { code: "invalid_request", message: "types must not name a presence event.", details: { field: "types" } } }]);
    const r2 = await run(fakeIo({ fetch: bad.fetch, env }), "events", "stream", "--types", "chat.presence_updated", "--json");
    expect(r2.code).toBe(1);
    expect(r2.json.error.code).toBe("invalid_request");
    expect(bad.calls).toHaveLength(1);
  });

  it("waits Retry-After on a 429 or 503 and tries again", async () => {
    const limit = { code: "stream_connection_limit", message: "This organization has reached its limit of open stream connections. Close one and reconnect." };
    const { fetch, calls } = sseFetch([
      { status: 429, headers: { "retry-after": "30" }, body: limit },
      { status: 503, headers: { "retry-after": "5" }, body: { code: "service_unavailable", message: "The event stream is temporarily unavailable. Retry shortly." } },
      { chunks: [frame(1, "c1.a")] },
    ]);
    const io = fakeIo({ fetch, env });
    const r = await run(io, "events", "stream", "--count", "1");
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(3);
    expect(io.sleeps).toEqual([30_000, 5_000]);
    expect(r.err).toContain("stream_connection_limit");
    expect(lines(r.out)).toHaveLength(1);
  });

  it("reconnects after a network error", async () => {
    const { fetch, calls } = sseFetch([new Error("socket hang up"), { chunks: [frame(1, "c1.a")] }]);
    const io = fakeIo({ fetch, env });
    const r = await run(io, "events", "stream", "--count", "1");
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(io.sleeps).toHaveLength(1);
  });

  it("needs a login, takes only stream arguments and refuses a key sent in clear text", async () => {
    const none = await run(fakeIo({ fetch: sseFetch([{ chunks: [] }]).fetch }), "events", "stream", "--json");
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
  });

  it("can point at another stream host", async () => {
    const { fetch, calls } = sseFetch([{ chunks: [frame(1, "c1.a")] }]);
    await run(fakeIo({ fetch, env: { ...env, WUAPI_STREAM_URL: "http://localhost:8080/" } }), "events", "stream", "--count", "1");
    expect(calls[0]!.url).toBe("http://localhost:8080/v1/events/stream");
  });

  it("is in the help", async () => {
    const io = fakeIo({ env });
    expect((await run(io, "help")).out).toContain("events stream");
    const h = await run(io, "events", "stream", "--help");
    expect(h.out).toContain("Last-Event-ID");
    expect(h.out).toContain("one JSON event per line");
    expect(h.out).toContain("Streams");
  });
});

describe("SseParser", () => {
  const dispatch = (...chunks: string[]) => {
    const p = new SseParser();
    return { frames: chunks.flatMap((c) => p.push(c)), parser: p };
  };

  it("joins data lines, keeps the last id, and reads every line ending", () => {
    const { frames, parser } = dispatch("id: c1.a\nevent: x\ndata: one\ndata: two\n\n", "data: three\r\n\r\n", "data: four\r\rdata: five\r\r");
    expect(frames.map((f) => f.data)).toEqual(["one\ntwo", "three", "four", "five"]);
    expect(frames[0]).toMatchObject({ id: "c1.a", event: "x" });
    // an id carries to the frames after it, like the browser's last event ID
    expect(frames[1]!.id).toBe("c1.a");
    expect(frames[1]!.event).toBe("message");
    expect(parser.lastEventId).toBe("c1.a");
  });

  it("takes the cursor of a frame with no data, ignores comments, and reads retry", () => {
    const { frames, parser } = dispatch(": ping\nid: c1.b\n\n", "retry: 7000\n\n", "retry: soon\n\n", ": only a comment\n\n");
    expect(frames).toEqual([]);
    expect(parser.lastEventId).toBe("c1.b");
    expect(parser.retryMs).toBe(7000);
  });

  it("keeps a half frame until the rest arrives", () => {
    const p = new SseParser();
    expect(p.push("id: c1.q\nda")).toEqual([]);
    expect(p.push("ta: {\"a\":1}\n")).toEqual([]);
    expect(p.push("\n")).toEqual([{ id: "c1.q", event: "message", data: '{"a":1}' }]);
  });

  it("ignores an id with a NUL, and strips one leading space only", () => {
    const { frames, parser } = dispatch("id: bad\u0000id\ndata:  two spaces\n\n");
    expect(frames[0]!.data).toBe(" two spaces");
    expect(parser.lastEventId).toBe("");
  });
});
