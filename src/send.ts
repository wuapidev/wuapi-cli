// `wuapi send <to> <text>`: queue a text message. One idempotency key per
// command, reused on every retry (the SDK's and ours), so a request cut off
// midway is replayed by the API instead of sent twice.

import { randomUUID } from "node:crypto";
import type { Message, Wuapi } from "@wuapidev/sdk";
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

export async function send(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["account", "accountId", "wait", "timeout", "idempotency-key"]);
  const [, to, text, ...rest] = ctx.args.positionals;
  if (!to || text === undefined || rest.length) throw usage('Usage: wuapi send <to> <text> [--account <id>] [--wait]  (quote the text: "Hello there")');
  const client = makeClient(ctx);
  const accountId = stringFlag(ctx.args, "account") ?? stringFlag(ctx.args, "accountId") ?? (await pickAccount(ctx, client));
  const idempotencyKey = stringFlag(ctx.args, "idempotency-key") ?? randomUUID();

  let message: Message | undefined;
  for (let attempt = 1; !message; attempt++) {
    try {
      message = await client.messages.send({ accountId, to, text }, { idempotencyKey });
    } catch (e) {
      if (!isTransient(e) || attempt >= SEND_ATTEMPTS) throw e;
      log(ctx, `wuapi: ${(e as Error).message} Retrying with the same idempotency key...`);
      await ctx.io.sleep(1000 * attempt);
    }
  }

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
