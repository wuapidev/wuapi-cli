// `wuapi events stream`: Streams from a terminal. Opens
// GET https://stream.wuapi.dev/v1/events/stream (text/event-stream) and prints each
// event's envelope as one JSON line on stdout, so it pipes into `jq` or a script. It
// reconnects by itself with `Last-Event-ID`, waiting the `retry` time the stream
// sent, and prints an event once even when a replay repeats it (delivery is
// at-least-once; the event `id` is stable). Hand-written: the stream is not in
// openapi.json, so it is not in src/generated.

import { allowOnly, numberFlag, stringFlag } from "./args.js";
import { isSafeBaseUrl, log, resolveAuth, type Auth, type Ctx } from "./context.js";
import { CliError, usage } from "./errors.js";

export const DEFAULT_STREAM_URL = "https://stream.wuapi.dev";
export const STREAM_PATH = "/v1/events/stream";
/** The stream's own default (`retry: 3000` opens every stream). */
const DEFAULT_RETRY_MS = 3_000;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 300_000;
/** The gateway refuses more than 50 values in `types` or `accounts`. */
const MAX_FILTER_VALUES = 50;
/** Event ids kept to drop a replay's repeats. */
const SEEN_MAX = 2_048;

export interface SseFrame {
  /** The last event ID when the frame was dispatched (carries over from earlier frames). */
  id: string;
  event: string;
  data: string;
}

/**
 * The event stream parsing of the WHATWG HTML standard, as far as a client needs:
 * `id`, `event`, `data` and `retry` fields, comments, CR, LF and CRLF line ends,
 * chunks that cut a line anywhere. Like a browser, the last event ID is updated at
 * every blank line, also when the block has no data (a `: ping` can carry an `id`).
 */
export class SseParser {
  lastEventId = "";
  retryMs: number | undefined;
  private idBuffer = "";
  private buffer = "";
  private event = "";
  private data: string[] = [];
  /** The previous chunk ended in CR: a LF that starts the next one belongs to it. */
  private skipLf = false;

  push(chunk: string): SseFrame[] {
    if (this.skipLf && chunk.length > 0) {
      if (chunk.startsWith("\n")) chunk = chunk.slice(1);
      this.skipLf = false;
    }
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.buffer.search(/[\r\n]/);
      if (end === -1) break;
      const line = this.buffer.slice(0, end);
      let next = end + 1;
      if (this.buffer[end] === "\r") {
        if (this.buffer[next] === "\n") next++;
        else if (next === this.buffer.length) this.skipLf = true;
      }
      this.buffer = this.buffer.slice(next);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): SseFrame | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") {
      if (!value.includes("\u0000")) this.idBuffer = value;
    } else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    return undefined;
  }

  private dispatch(): SseFrame | undefined {
    this.lastEventId = this.idBuffer;
    if (this.data.length === 0) {
      this.event = "";
      return undefined;
    }
    const frame = { id: this.lastEventId, event: this.event || "message", data: this.data.join("\n") };
    this.event = "";
    this.data = [];
    return frame;
  }
}

/** The values of a `--types a,b` style flag. */
function listFlag(ctx: Ctx, name: string): string | undefined {
  const raw = stringFlag(ctx.args, name);
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) throw usage(`--${name} needs at least one value.`);
  if (values.length > MAX_FILTER_VALUES) throw usage(`--${name} takes at most ${MAX_FILTER_VALUES} values.`);
  return values.join(",");
}

function streamUrl(ctx: Ctx): URL {
  const base = stringFlag(ctx.args, "stream-url") ?? (ctx.io.env.WUAPI_STREAM_URL?.trim() || undefined) ?? DEFAULT_STREAM_URL;
  if (!isSafeBaseUrl(base)) throw usage("The stream URL must be https (or http://localhost for development): the key goes in its Authorization header.");
  const url = new URL(`${base.replace(/\/+$/, "")}${STREAM_PATH}`);
  const types = listFlag(ctx, "types");
  const accounts = listFlag(ctx, "accounts");
  if (types) url.searchParams.set("types", types);
  if (accounts) url.searchParams.set("accounts", accounts);
  return url;
}

interface ErrorBody {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

async function errorBody(res: Response): Promise<ErrorBody> {
  try {
    const body = (await res.json()) as ErrorBody;
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

/** 429 or a server error: waiting is the answer. Anything else is a refusal. */
const waitsAndRetries = (status: number) => status === 429 || status >= 500;

function retryAfterMs(res: Response, fallback: number): number {
  const seconds = Number(res.headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

const clampRetry = (ms: number) => Math.min(Math.max(ms, MIN_RETRY_MS), MAX_RETRY_MS);

/** What `wuapi events stream --help` prints. */
export const EVENTS_HELP = [
  "Usage: wuapi events stream [--types a,b] [--accounts id,id] [--count n] [--last-event-id <id>]",
  "",
  "Streams: prints your events live, one JSON event per line on stdout (the same envelope a",
  "webhook carries), so it pipes into jq or a script. Logs, reconnects and resets go to stderr.",
  "Press Ctrl-C to stop. No public endpoint needed: use it to see what your account emits,",
  "or to build against Streams before writing a client.",
  "",
  "  --types a,b            only these event types (up to 50). Presence events are not on Streams",
  "  --accounts id,id       only these accounts (up to 50)",
  "  --count n              exit after n events (default: run until stopped)",
  "  --last-event-id <id>   resume from a cursor: wuapi replays what happened since (30 minutes at most)",
  "  --project <id>         scope an organization key to one project (or WUAPI_PROJECT)",
  "  --stream-url <url>     another stream host (or WUAPI_STREAM_URL; default https://stream.wuapi.dev)",
  "",
  "It sends the key in the Authorization header only, reconnects by itself with Last-Event-ID,",
  "waits the retry time the stream asks for, and prints an event once even when a replay repeats it.",
  "A `reset` means the cursor was too old: the CLI says so on stderr; resync with `wuapi messages list`",
  "(REST) and carry on. The Free plan allows 3 open stream connections per organization.",
].join("\n");

export async function events(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["types", "accounts", "count", "last-event-id", "stream-url"]);
  const [, sub, ...extra] = ctx.args.positionals;
  if (sub !== "stream" || extra.length) throw usage("Usage: wuapi events stream [--types a,b] [--accounts id,id] [--count n] [--last-event-id <id>]");
  const url = streamUrl(ctx);
  const maxEvents = ctx.args.flags.has("count") ? Math.floor(numberFlag(ctx.args, "count", 1)) : Number.POSITIVE_INFINITY;
  const auth = resolveAuth(ctx);

  let cursor = stringFlag(ctx.args, "last-event-id") ?? "";
  let retryMs = DEFAULT_RETRY_MS;
  let printed = 0;
  const seen = new Set<string>();

  const wait = async (ms: number, why: string) => {
    log(ctx, `wuapi: ${why} Reconnecting in ${Math.ceil(ms / 1000)}s.`);
    await ctx.io.sleep(ms);
  };

  for (;;) {
    let res: Response;
    try {
      res = await ctx.io.fetch(url.toString(), { headers: requestHeaders(auth, cursor) });
    } catch (e) {
      await wait(clampRetry(retryMs), `${(e as Error).message}.`);
      continue;
    }

    if (!res.ok) {
      const body = await errorBody(res);
      const code = body.code ?? "stream_error";
      const message = body.message ?? `The stream answered ${res.status}.`;
      if (!waitsAndRetries(res.status)) {
        throw new CliError(code, message, { details: { status: res.status, ...(body.details ?? {}) } });
      }
      await wait(retryAfterMs(res, clampRetry(retryMs)), `${code}: ${message}`);
      continue;
    }
    if (!res.body) {
      await wait(clampRetry(retryMs), "The stream sent no body.");
      continue;
    }

    const parser = new SseParser();
    parser.lastEventId = cursor;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let finished = false;
    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.event === "reset") {
            log(ctx, `wuapi: the stream was reset (${resetReason(frame.data)}): events may have been missed. Resync through REST (wuapi messages list, wuapi chats list) and carry on.`);
            continue;
          }
          const id = eventId(frame.data);
          if (id === undefined) {
            log(ctx, `wuapi: skipped a ${frame.event} frame that is not an event.`);
            continue;
          }
          if (seen.has(id)) continue;
          seen.add(id);
          if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
          ctx.io.out(`${frame.data}\n`);
          printed++;
          if (printed >= maxEvents) {
            finished = true;
            break;
          }
        }
        if (parser.lastEventId) cursor = parser.lastEventId;
      }
    } catch (e) {
      log(ctx, `wuapi: the stream was cut (${(e as Error).message}).`);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (finished) return;
    if (parser.retryMs !== undefined) retryMs = parser.retryMs;
    await wait(clampRetry(retryMs), "The stream ended.");
  }
}

function requestHeaders(auth: Auth, cursor: string): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.apiKey}`,
    Accept: "text/event-stream",
    ...(auth.project ? { "Wuapi-Project": auth.project } : {}),
    ...(cursor ? { "Last-Event-ID": cursor } : {}),
  };
}

/** The `evt_` id of an event frame's data, or undefined when it is not an envelope. */
function eventId(data: string): string | undefined {
  try {
    const body = JSON.parse(data) as { id?: unknown; object?: unknown };
    return body && body.object === "event" && typeof body.id === "string" ? body.id : undefined;
  } catch {
    return undefined;
  }
}

function resetReason(data: string): string {
  try {
    const reason = (JSON.parse(data) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : "unknown";
  } catch {
    return "unknown";
  }
}
