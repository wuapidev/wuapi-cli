// `wuapi send <to> <text>`: queue a text message, or with `--file` a local
// file (uploaded first, then sent by its upload id). One idempotency key per
// command, reused on every retry (the SDK's and ours), so a request cut off
// midway is replayed by the API instead of sent twice: the upload answers the
// same upload, the send the same message.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import type { Message, MessagesSendParams, Wuapi } from "@wuapidev/sdk";
import { allowOnly, boolFlag, numberFlag, stringFlag } from "./args.js";
import { emit, log, makeClient, type Ctx } from "./context.js";
import { CliError, usage } from "./errors.js";
import { isTransient } from "./link.js";

const POLL_MS = 2_000;
const SEND_ATTEMPTS = 3;
const DONE = new Set(["sent", "delivered", "read", "played"]);

async function pickAccount(ctx: Ctx, client: Wuapi): Promise<string> {
  const { items } = await client.accounts.list({ limit: 100 }).page();
  const ready = items.filter((a) => a.status === "ready");
  if (ready.length === 1) {
    log(ctx, `wuapi: sending from ${ready[0]!.id}${ready[0]!.phone ? ` (${ready[0]!.phone})` : ""}`);
    return ready[0]!.id;
  }
  if (ready.length === 0) {
    throw new CliError("no_ready_account", items.length ? "No account is ready to send. Check `wuapi accounts list`." : "No linked number yet. Run `wuapi link` first.");
  }
  throw new CliError("account_required", `Several accounts are ready: pass --account <id> (${ready.map((a) => a.id).join(", ")}).`, {
    exitCode: 2,
    details: { accounts: ready.map((a) => ({ id: a.id, phone: a.phone, name: a.name })) },
  });
}

const FILE_TYPES = ["image", "video", "audio", "voice", "document", "sticker"] as const;
type FileType = (typeof FILE_TYPES)[number];

/** MIME types by extension, for the files people send most. Anything else needs --mime-type. */
const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg; codecs=opus",
  ".oga": "audio/ogg; codecs=opus",
  ".opus": "audio/ogg; codecs=opus",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The message type a file is sent as when --type does not say: by what the file is. */
function typeFor(mimeType: string): FileType {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

/** What `--file` names: its bytes, MIME type, the type to send it as, and its name for a document. */
function readAttachment(ctx: Ctx, file: string): { bytes: Uint8Array; mimeType: string; type: FileType; filename: string } {
  const path = isAbsolute(file) ? file : join(ctx.io.cwd, file);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    throw usage(`Cannot read ${file}: ${(e as Error).message}`);
  }
  if (bytes.length === 0) throw usage(`${file} is empty.`);
  const mimeType = stringFlag(ctx.args, "mime-type") ?? MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mimeType) throw usage(`Cannot tell the type of ${file} from its extension. Pass --mime-type, for example --mime-type application/pdf.`);
  const asType = stringFlag(ctx.args, "type");
  if (asType !== undefined && !(FILE_TYPES as readonly string[]).includes(asType)) throw usage(`--type must be one of ${FILE_TYPES.join(", ")}.`);
  return { bytes, mimeType, type: (asType as FileType | undefined) ?? typeFor(mimeType), filename: stringFlag(ctx.args, "filename") ?? basename(path) };
}

const SEND_USAGE =
  'Usage: wuapi send <to> <text> [--account <id>] [--wait]  (quote the text: "Hello there")\n       wuapi send <to> [caption] --file <path> [--type voice] [--mime-type <type>]';

/** Run one API step, repeating it (same idempotency key) when the connection drops. */
async function withRetries<T>(ctx: Ctx, step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (e) {
      if (!isTransient(e) || attempt >= SEND_ATTEMPTS) throw e;
      log(ctx, `wuapi: ${(e as Error).message} Retrying with the same idempotency key...`);
      await ctx.io.sleep(1000 * attempt);
    }
  }
}

export async function send(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["account", "accountId", "wait", "timeout", "idempotency-key", "file", "type", "mime-type", "filename"]);
  const [, to, text, ...rest] = ctx.args.positionals;
  const file = stringFlag(ctx.args, "file");
  if (!to || rest.length || (text === undefined && file === undefined)) throw usage(SEND_USAGE);
  if (file === undefined && ["type", "mime-type", "filename"].some((f) => ctx.args.flags.has(f))) {
    throw usage(`--type, --mime-type and --filename go with --file.\n${SEND_USAGE}`);
  }
  const attachment = file !== undefined ? readAttachment(ctx, file) : undefined;
  const client = makeClient(ctx);
  const accountId = stringFlag(ctx.args, "account") ?? stringFlag(ctx.args, "accountId") ?? (await pickAccount(ctx, client));
  const idempotencyKey = stringFlag(ctx.args, "idempotency-key") ?? randomUUID();

  let params: MessagesSendParams = { accountId, to, text: text ?? "" };
  if (attachment) {
    // The upload has its own key, derived from the command's: a retry answers the same upload.
    const upload = await withRetries(ctx, () =>
      client.uploads.upload(attachment.bytes, { mimeType: attachment.mimeType, filename: attachment.filename }, { idempotencyKey: `${idempotencyKey}:upload` }),
    );
    const media = { uploadId: upload.id, ...(attachment.type === "document" ? { filename: attachment.filename } : {}) };
    params = { accountId, to, type: attachment.type, media, ...(text ? { text } : {}) };
  }
  let message: Message = await withRetries(ctx, () => client.messages.send(params, { idempotencyKey }));

  if (boolFlag(ctx.args, "wait")) {
    const deadline = ctx.io.now() + numberFlag(ctx.args, "timeout", 120) * 1000;
    while (!DONE.has(message.status) && message.status !== "failed") {
      if (ctx.io.now() + POLL_MS > deadline) {
        throw new CliError("wait_timeout", `Message ${message.id} is still ${message.status}. Check it later: wuapi messages get ${message.id}`, {
          details: { messageId: message.id, status: message.status },
        });
      }
      await ctx.io.sleep(POLL_MS);
      try {
        message = await client.messages.get(message.id);
      } catch (e) {
        if (!isTransient(e)) throw e;
      }
    }
    if (message.status === "failed") {
      const err = (message as { error?: { code?: string; message?: string } | null }).error;
      throw new CliError(err?.code ?? "message_failed", `Message ${message.id} failed${err?.message ? `: ${err.message}` : "."}`, {
        details: { messageId: message.id, status: message.status, ...(err ? { error: err } : {}) },
      });
    }
  }
  emit(ctx, { id: message.id, status: message.status, accountId: message.accountId, chatId: message.chatId, idempotencyKey, message }, () => `${message.id} ${message.status}`);
}
