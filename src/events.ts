// `wuapi events stream`: Streams from a terminal. Opens the event stream
// (GET https://stream.wuapi.dev/v1/events/stream, text/event-stream) through the
// SDK's Streams client (`EventStream`, packages/sdk-codegen/streams/CONTRACT.md) and
// prints each event's envelope as one JSON line on stdout, so it pipes into `jq`
// or a script. The client connects, parses, reconnects with `Last-Event-ID`, waits
// as the contract says and prints an event once even when a replay repeats it
// (delivery is at-least-once; the event `id` is stable). This file only maps flags
// to it and its reports to stderr.

import { EventStream, HttpClient, STREAM_SPEC, StreamError, type StreamStatus } from "@wuapidev/sdk";
import { allowOnly, numberFlag, stringFlag } from "./args.js";
import { isSafeBaseUrl, log, resolveAuth, type Ctx } from "./context.js";
import { CliError, usage } from "./errors.js";

export const DEFAULT_STREAM_URL = STREAM_SPEC.baseUrl;
export const STREAM_PATH = STREAM_SPEC.path;
/** The gateway refuses more than 50 values in `types` or `accounts`. */
const MAX_FILTER_VALUES = 50;

/** The values of a `--types a,b` style flag. */
function listFlag(ctx: Ctx, name: string): string[] | undefined {
  const raw = stringFlag(ctx.args, name);
  if (raw === undefined) return undefined;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) throw usage(`--${name} needs at least one value.`);
  if (values.length > MAX_FILTER_VALUES) throw usage(`--${name} takes at most ${MAX_FILTER_VALUES} values.`);
  return values;
}

/** --stream-url > WUAPI_STREAM_URL; without either the client picks the host (CONTRACT.md §1.4). */
function streamBaseUrl(ctx: Ctx): string | undefined {
  const base = stringFlag(ctx.args, "stream-url") ?? (ctx.io.env.WUAPI_STREAM_URL?.trim() || undefined);
  if (base !== undefined && !isSafeBaseUrl(base)) {
    throw usage("The stream URL must be https (or http://localhost for development): the key goes in its Authorization header.");
  }
  return base;
}

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
  "  --last-event-id <id>   resume from a cursor: wuapi replays what happened since (28 minutes at most)",
  "  --project <id>         scope an organization key to one project (or WUAPI_PROJECT)",
  "  --stream-url <url>     another stream host (or WUAPI_STREAM_URL; default https://stream.wuapi.dev)",
  "",
  "It sends the key in the Authorization header only, reconnects by itself with Last-Event-ID,",
  "waits at least the retry time the stream asks for (a little longer, spread at random), and prints",
  "an event once even when a replay repeats it.",
  "A `reset` means the cursor was too old: the CLI says so on stderr; resync with `wuapi messages list`",
  "(REST) and carry on. The Free plan allows 3 open stream connections per organization.",
].join("\n");


export async function events(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["types", "accounts", "count", "last-event-id", "stream-url"]);
  const [, sub, ...extra] = ctx.args.positionals;
  if (sub !== "stream" || extra.length) throw usage("Usage: wuapi events stream [--types a,b] [--accounts id,id] [--count n] [--last-event-id <id>]");
  const filters = { types: listFlag(ctx, "types"), accounts: listFlag(ctx, "accounts") };
  const streamUrl = streamBaseUrl(ctx);
  const maxEvents = ctx.args.flags.has("count") ? Math.floor(numberFlag(ctx.args, "count", 1)) : Number.POSITIVE_INFINITY;
  const auth = resolveAuth(ctx);
  const lastEventId = stringFlag(ctx.args, "last-event-id");

  const http = new HttpClient({
    apiKey: auth.apiKey,
    baseUrl: auth.baseUrl,
    ...(auth.project ? { project: auth.project } : {}),
    ...(streamUrl ? { streamBaseUrl: streamUrl } : {}),
    fetch: ctx.io.fetch,
  });
  let stream: EventStream;
  try {
    stream = new EventStream(http, STREAM_SPEC, { filters, lastEventId }, { onStatus: (status) => report(ctx, status) }, ctx.io.streamRuntime);
  } catch (e) {
    throw usage((e as Error).message);
  }

  let printed = 0;
  try {
    for await (const item of stream.items()) {
      if (item.type !== "event") continue;
      ctx.io.out(`${item.data}\n`);
      printed++;
      if (printed >= maxEvents) return;
    }
  } catch (e) {
    if (e instanceof StreamError) throw new CliError(e.code, e.message, { details: { status: e.status } });
    throw e;
  }
}

/** What the stream reports besides events, on stderr: stdout stays to events. */
function report(ctx: Ctx, status: StreamStatus): void {
  switch (status.type) {
    case "reset":
      log(ctx, `wuapi: the stream was reset (${status.reason}): events may have been missed. Resync through REST (wuapi messages list, wuapi chats list) and carry on.`);
      return;
    case "skipped":
      log(ctx, status.reason === "oversized" ? "wuapi: skipped a frame over the size limit." : `wuapi: skipped a ${status.name ?? "message"} frame that is not an event.`);
      return;
    case "reconnecting":
      log(ctx, `wuapi: ${why(status)} Reconnecting in ${Math.ceil(status.delayMs / 1000)}s.`);
      return;
    case "open":
      return;
  }
}

function why(status: Extract<StreamStatus, { type: "reconnecting" }>): string {
  switch (status.reason) {
    case "refused":
      return `${status.code ?? "stream_error"}: ${status.message ?? `The stream answered ${status.status}.`}`;
    case "unreachable":
      return `${status.message ?? "The stream could not be reached"}.`;
    case "cut":
      return `The stream was cut (${status.message ?? "read failed"}).`;
    case "idle":
      return "The stream was silent for too long.";
    case "ended":
      return "The stream ended.";
  }
}
