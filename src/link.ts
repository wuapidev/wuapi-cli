// `wuapi link`: link a WhatsApp number. By default it creates an invitation
// (POST /v1/invitations), a hosted page the person opens to link their number
// with a QR code or a pairing code, and waits until the account it creates is
// `ready`. The CLI never shows a QR code or pairing code in this mode, so an
// agent running it never sees or relays one. `wuapi link --here` is the old
// in-terminal flow (QR code here, or a pairing code with --phone), for a person
// at the terminal. `wuapi wait`: the waiting half, for an account or an
// invitation that already exists.
//
// Waiting polls GET /v1/invitations/{id} and GET /v1/accounts/{id} every 2 s,
// bounded by --timeout. A failed poll (network drop, timeout, 5xx) is retried
// on the next tick; only a terminal state (failed, expired, logged out, link
// timeout, ...) or the deadline ends it.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WuapiError, type Account, type Invitation, type ProxyLocationItem, type Wuapi } from "@wuapidev/sdk";
import { allowOnly, boolFlag, numberFlag, stringFlag } from "./args.js";
import { emit, log, makeClient, resolveAuth, type Ctx } from "./context.js";
import { countryFromPhone, normalizePhone } from "./dialcodes.js";
import { CliError, usage } from "./errors.js";
import { qrToTerminal, pngFromDataUrl } from "./qr.js";

const POLL_MS = 2_000;
const LINK_PATH = "WhatsApp > Settings > Linked devices > Link a device";
/** Reasons an account does not come back from on its own within a wait. */
const TERMINAL_REASONS = new Set(["logged_out", "link_timeout", "free_limit_reached", "proxy_paused", "temporary_ban", "activation_required"]);

/** Worth another poll: the network, a timeout, rate limiting or a server error. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof WuapiError)) return false;
  return e.status === 0 ? e.code === "network_error" || e.code === "timeout" : e.status === 429 || e.status >= 500;
}

function terminal(account: Account): CliError | undefined {
  if (account.status === "failed") {
    return new CliError("account_failed", `Account ${account.id} failed${account.lastError ? `: ${account.lastError}` : ""}. Run \`wuapi accounts reconnect ${account.id}\` to start over.`, {
      details: { accountId: account.id, status: account.status, lastError: account.lastError },
    });
  }
  if (account.status === "disconnected" && !account.reconnecting && account.disconnectReason && TERMINAL_REASONS.has(account.disconnectReason)) {
    const hint =
      account.disconnectReason === "link_timeout"
        ? ` Run \`wuapi accounts reconnect ${account.id}\` for a new code.`
        : account.disconnectReason === "logged_out"
          ? " The phone removed this linked device."
          : "";
    return new CliError(`account_${account.disconnectReason}`, `Account ${account.id} is disconnected (${account.disconnectReason}).${hint}`, {
      details: { accountId: account.id, status: account.status, disconnectReason: account.disconnectReason },
    });
  }
  return undefined;
}

interface Shown {
  qr: string | null;
  code: string | null;
  qrFile: string | null;
  opened: boolean;
}

function qrFiles(accountId: string) {
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, "");
  return { png: join(tmpdir(), `wuapi-qr-${safe}.png`), html: join(tmpdir(), `wuapi-qr-${safe}.html`) };
}

function writeQrFiles(accountId: string, dataUrl: string, linked = false): { png: string; html: string } {
  const files = qrFiles(accountId);
  if (!linked) writeFileSync(files.png, pngFromDataUrl(dataUrl));
  // The page reloads itself, so it always shows the newest code.
  const body = linked
    ? "<h1>Linked</h1><p>The number is linked. You can close this tab.</p>"
    : `<h1>Scan with WhatsApp</h1><p>${LINK_PATH}. The code refreshes on its own.</p><img src="${files.png.split(/[\\/]/).pop()}?t=${Date.now()}" width="320" height="320" alt="QR code">`;
  writeFileSync(
    files.html,
    `<!doctype html><meta charset="utf-8">${linked ? "" : '<meta http-equiv="refresh" content="3">'}<title>wuapi: link a number</title><body style="font-family:system-ui;text-align:center;padding:2rem">${body}</body>`,
  );
  return files;
}

function showCodes(ctx: Ctx, account: Account, shown: Shown, open: boolean): boolean {
  let changed = false;
  if (account.status === "qr_ready" && account.qrCodeUrl && account.qrCodeUrl !== shown.qr) {
    const first = shown.qr === null;
    shown.qr = account.qrCodeUrl;
    changed = true;
    let files: { png: string; html: string } | undefined;
    try {
      files = writeQrFiles(account.id, account.qrCodeUrl);
      shown.qrFile = files.png;
    } catch {
      files = undefined;
    }
    if (open && files && !shown.opened) {
      ctx.io.open(files.html);
      shown.opened = true;
    }
    if (ctx.json) {
      log(ctx, `wuapi: ${first ? "QR code ready" : "QR code refreshed"}${files ? `: ${files.png}` : ""}`);
    } else {
      const art = qrToTerminal(account.qrCodeUrl, ctx.io.stdoutIsTTY && !ctx.io.env.NO_COLOR);
      ctx.io.out(`${first ? "" : "\nThe QR code refreshed:\n"}${art ?? `(Cannot draw the QR code here${files ? `; open ${files.png}` : ""}.)`}\n`);
      if (first) ctx.io.out(`Scan it: ${LINK_PATH}.${files && !open ? `\nOr open it in a browser: wuapi link --here --open, or ${files.html}` : ""}\n`);
    }
  }
  if (account.status !== "ready" && account.pairingCode && account.pairingCode !== shown.code) {
    const first = shown.code === null;
    shown.code = account.pairingCode;
    changed = true;
    if (ctx.json) log(ctx, `wuapi: pairing code ${account.pairingCode}`);
    else {
      ctx.io.out(`${first ? "" : "\nNew pairing code (the last one expired):\n"}\n  Pairing code:  ${account.pairingCode}\n\n`);
      if (first) ctx.io.out(`On the phone: ${LINK_PATH} > Link with phone number instead, and type the code.\n`);
    }
  }
  return changed;
}

/**
 * Polls the account until it is ready (or, with `untilCode`, until it shows a
 * QR code or pairing code), printing each new code. Bounded by `timeoutMs`.
 */
export async function waitForAccount(
  ctx: Ctx,
  client: Wuapi,
  accountId: string,
  opts: { timeoutMs: number; untilCode?: boolean; open?: boolean; quiet?: boolean },
): Promise<{ account: Account; shown: Shown }> {
  const deadline = ctx.io.now() + opts.timeoutMs;
  const shown: Shown = { qr: null, code: null, qrFile: null, opened: false };
  let last: Account | undefined;
  let lastStatus = "";
  let failures = 0;
  for (;;) {
    let account: Account | undefined;
    try {
      account = await client.accounts.get(accountId);
      failures = 0;
    } catch (e) {
      if (!isTransient(e)) throw e;
      failures++;
      if (failures === 1 || failures % 10 === 0) log(ctx, `wuapi: ${(e as Error).message} Retrying...`);
    }
    if (account) {
      last = account;
      if (account.status !== lastStatus) {
        if (lastStatus && (ctx.json || !ctx.io.stdoutIsTTY || account.status !== "qr_ready")) log(ctx, `wuapi: status ${account.status}`);
        lastStatus = account.status;
      }
      if (account.status === "ready") {
        if (shown.qr && shown.opened) {
          try {
            writeQrFiles(account.id, "", true);
          } catch {
            // The page just keeps its last code.
          }
        }
        return { account, shown };
      }
      const t = terminal(account);
      if (t) throw t;
      // quiet: an invitation's account; its codes belong to the person on the page.
      const changed = opts.quiet ? false : showCodes(ctx, account, shown, opts.open ?? false);
      if (opts.untilCode && (shown.qr || shown.code) && changed) return { account, shown };
    }
    if (ctx.io.now() + POLL_MS > deadline) {
      throw new CliError(
        "wait_timeout",
        `Timed out waiting for account ${accountId}${last ? ` (status ${last.status})` : ""}. Run \`wuapi wait ${accountId}\` to keep waiting.`,
        { details: { accountId, status: last?.status ?? null } },
      );
    }
    await ctx.io.sleep(POLL_MS);
  }
}

function readyText(account: Account): string {
  return `Linked${account.phone ? ` ${account.phone}` : ""}${account.profileName ? ` (${account.profileName})` : ""}. Account ${account.id} is ready.`;
}

function readyJson(account: Account) {
  return { accountId: account.id, status: account.status, phone: account.phone, profileName: account.profileName, account };
}

/** The proxy location: the country's biggest city, or the best match for `city`. */
async function findLocation(client: Wuapi, country: string, city: string | undefined): Promise<ProxyLocationItem | undefined> {
  const page = await client.proxyLocations.list(city ? { q: city, country, limit: 1 } : { country, limit: 1 }).page();
  return page.items[0];
}

function noLocation(country: string, city: string | undefined): CliError {
  return new CliError(
    "unsupported_proxy_location",
    city ? `No proxy location matches "${city}" in ${country}. See https://wuapi.dev/proxy-locations.` : `No proxy location in ${country}. See https://wuapi.dev/proxy-locations.`,
    { exitCode: 2 },
  );
}

interface LinkFlags {
  phone: string | undefined;
  countryFlag: string | undefined;
  country: string | undefined;
  city: string | undefined;
  name: string | undefined;
  noWait: boolean;
}

function linkFlags(ctx: Ctx): LinkFlags {
  if (ctx.args.positionals.length > 1) throw usage("wuapi link takes flags only: wuapi link [--phone +E164] [--country XX] [--city name] [--name label]");
  const phoneFlag = stringFlag(ctx.args, "phone");
  const phone = phoneFlag === undefined ? undefined : normalizePhone(phoneFlag);
  if (phoneFlag !== undefined && !phone) throw usage("--phone must be a phone number in international format, like +584121234567.");
  const countryFlag = stringFlag(ctx.args, "country");
  if (countryFlag !== undefined && !/^[A-Za-z]{2}$/.test(countryFlag)) throw usage("--country must be a two-letter ISO code, like VE or US.");
  const country = (countryFlag ?? (phone ? countryFromPhone(phone) : undefined))?.toUpperCase();
  return { phone, countryFlag, country, city: stringFlag(ctx.args, "city"), name: stringFlag(ctx.args, "name"), noWait: boolFlag(ctx.args, "no-wait") };
}

export async function link(ctx: Ctx): Promise<void> {
  if (boolFlag(ctx.args, "here")) return linkHere(ctx);
  return linkByInvitation(ctx);
}

/**
 * The default: an invitation the person opens in the browser, where they pick
 * the QR code or the pairing code. Nothing here ever prints either.
 */
async function linkByInvitation(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["phone", "country", "city", "name", "no-wait", "timeout", "no-browser", "here"]);
  const f = linkFlags(ctx);
  if (f.city && !f.country) throw usage("--city needs --country (or a --phone whose country is known).");
  const timeoutMs = numberFlag(ctx.args, "timeout", 900) * 1000;
  const auth = resolveAuth(ctx);
  const client = makeClient(ctx, auth);

  // Preset where the number's proxy exits when we know the country; without
  // one the person picks it on the page.
  let proxyLocation: { country: string; city: string } | undefined;
  if (f.country) {
    const location = await findLocation(client, f.country, f.city);
    if (location) {
      proxyLocation = { country: location.country, city: location.city };
      log(ctx, `wuapi: proxy location ${location.cityName}, ${location.countryName} (${location.country}/${location.city})`);
    } else if (f.countryFlag || f.city) {
      throw noLocation(f.country, f.city);
    } else {
      log(ctx, `wuapi: no proxy location in ${f.country}; the person picks one on the page.`);
    }
  }

  // One idempotency key for the create: the SDK's retries replay it instead of
  // creating a second invitation. A project key invites into its own project;
  // an organization key into --project / WUAPI_PROJECT / the profile's project.
  const invitation = await client.invitations.create(
    {
      methods: ["qr_code", "pairing_code"],
      expiresInDays: 1,
      ...(auth.project ? { projectId: auth.project } : {}),
      ...(f.name ? { accountName: f.name } : {}),
      ...(f.phone ? { inviteePhone: f.phone } : {}),
      ...(f.country ? { suggestedCountry: f.country } : {}),
      ...(proxyLocation ? { proxyLocation } : {}),
    },
    { idempotencyKey: randomUUID() },
  );
  const url = invitation.url;
  if (!url) throw new CliError("invalid_response", `The API created invitation ${invitation.id} without a link.`, { details: { invitationId: invitation.id } });
  log(ctx, `wuapi: created invitation ${invitation.id}`);
  if (!boolFlag(ctx.args, "no-browser")) ctx.io.open(url);

  const openText = `Open this link to link your number (QR code or pairing code): ${url}`;
  if (f.noWait) {
    emit(ctx, { invitationId: invitation.id, url, expiresAt: invitation.expiresAt }, () =>
      [openText, `It expires at ${invitation.expiresAt}. Run \`wuapi wait ${invitation.id}\` to wait until the number is linked.`].join("\n"),
    );
    return;
  }
  if (ctx.json) log(ctx, `wuapi: ${openText}`);
  else ctx.io.out(`${openText}\nWaiting until it is linked...\n`);
  const { account } = await waitForInvitation(ctx, client, invitation.id, { timeoutMs });
  emit(ctx, invitationReadyJson(invitation.id, account), () => readyText(account));
}

function invitationError(inv: Invitation): CliError | undefined {
  const details = { invitationId: inv.id, status: inv.status, failureReason: inv.failureReason, accountId: inv.accountId };
  if (inv.status === "failed") {
    return new CliError(
      "invitation_failed",
      `Invitation ${inv.id} failed${inv.failureReason ? ` (${inv.failureReason})` : ""}. The person can try again on the same link (then run \`wuapi wait ${inv.id}\`), or run \`wuapi link\` for a new one.`,
      { details },
    );
  }
  if (inv.status === "expired") return new CliError("invitation_expired", `Invitation ${inv.id} expired before the number was linked. Run \`wuapi link\` for a new link.`, { details });
  if (inv.status === "cancelled") return new CliError("invitation_cancelled", `Invitation ${inv.id} was cancelled. Run \`wuapi link\` for a new link.`, { details });
  return undefined;
}

/**
 * Polls the invitation until it is completed, then waits until its account is
 * ready. Never prints the account's QR code or pairing code.
 */
export async function waitForInvitation(
  ctx: Ctx,
  client: Wuapi,
  invitationId: string,
  opts: { timeoutMs: number; first?: Invitation },
): Promise<{ invitation: Invitation; account: Account }> {
  const deadline = ctx.io.now() + opts.timeoutMs;
  let pending: Invitation | undefined = opts.first;
  let last: Invitation | undefined;
  let lastStatus = "";
  let failures = 0;
  for (;;) {
    let inv: Invitation | undefined = pending;
    pending = undefined;
    if (!inv) {
      try {
        inv = await client.invitations.get(invitationId);
        failures = 0;
      } catch (e) {
        if (!isTransient(e)) throw e;
        failures++;
        if (failures === 1 || failures % 10 === 0) log(ctx, `wuapi: ${(e as Error).message} Retrying...`);
      }
    }
    if (inv) {
      last = inv;
      if (inv.status !== lastStatus) {
        if (lastStatus) log(ctx, `wuapi: invitation ${inv.status}`);
        lastStatus = inv.status;
      }
      if (inv.status === "completed" && inv.accountId) {
        const { account } = await waitForAccount(ctx, client, inv.accountId, { timeoutMs: Math.max(deadline - ctx.io.now(), POLL_MS), quiet: true });
        return { invitation: inv, account };
      }
      const t = invitationError(inv);
      if (t) throw t;
    }
    if (ctx.io.now() + POLL_MS > deadline) {
      throw new CliError(
        "wait_timeout",
        `Timed out waiting for invitation ${invitationId}${last ? ` (status ${last.status})` : ""}. Run \`wuapi wait ${invitationId}\` to keep waiting.`,
        { details: { invitationId, status: last?.status ?? null } },
      );
    }
    await ctx.io.sleep(POLL_MS);
  }
}

/** The old in-terminal flow: for a person at the terminal. Agents should not use it. */
async function linkHere(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["phone", "country", "city", "name", "open", "no-wait", "timeout", "here"]);
  const { phone, country, city, name, noWait } = linkFlags(ctx);
  if (!country) {
    throw new CliError(
      "missing_country",
      phone
        ? `Cannot tell the country of ${phone}. Pass --country XX (ISO code), the country the number's traffic should exit from.`
        : "Pass --country XX (ISO code, like VE or US): the number's own country, where its traffic exits from. Or pass --phone to link by pairing code; the country then defaults to the number's.",
      { exitCode: 2 },
    );
  }
  const timeoutMs = numberFlag(ctx.args, "timeout", 300) * 1000;
  const open = boolFlag(ctx.args, "open");
  const client = makeClient(ctx);

  const location = await findLocation(client, country, city);
  if (!location) throw noLocation(country, city);
  log(ctx, `wuapi: proxy location ${location.cityName}, ${location.countryName} (${location.country}/${location.city})`);

  // One idempotency key for the create: the SDK's retries replay it instead of
  // creating a second account.
  const account = await client.accounts.create(
    {
      proxyLocation: { country: location.country, city: location.city },
      ...(name ? { name } : {}),
      ...(phone ? { pairingPhone: phone } : {}),
    },
    { idempotencyKey: randomUUID() },
  );
  log(ctx, `wuapi: created account ${account.id}`);

  if (noWait) {
    const { account: withCode, shown } = await waitForAccount(ctx, client, account.id, { timeoutMs, untilCode: true, open });
    emit(
      ctx,
      {
        accountId: withCode.id,
        status: withCode.status,
        ...(withCode.pairingCode ? { pairingCode: withCode.pairingCode, pairingCodeExpiresAt: withCode.pairingCodeExpiresAt } : {}),
        ...(withCode.qrCodeUrl ? { qrCodeUrl: withCode.qrCodeUrl } : {}),
        ...(shown.qrFile ? { qrCodeFile: shown.qrFile } : {}),
      },
      () =>
        withCode.status === "ready"
          ? readyText(withCode)
          : `Account ${withCode.id} created. Codes rotate: run \`wuapi wait ${withCode.id}\` to show new ones and wait until it is linked.`,
    );
    return;
  }
  const { account: ready } = await waitForAccount(ctx, client, account.id, { timeoutMs, open });
  emit(ctx, readyJson(ready), () => readyText(ready));
}

function invitationReadyJson(invitationId: string, account: Account) {
  return { invitationId, accountId: account.id, phone: account.phone, status: account.status, profileName: account.profileName };
}

/**
 * `wuapi wait <id>`: an account id, or an invitation id from `wuapi link
 * --no-wait`. Ids carry no prefix, so an id the accounts endpoint does not
 * know (404) is tried as an invitation.
 */
export async function wait(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["timeout", "open"]);
  const id = ctx.args.positionals[1];
  if (!id || ctx.args.positionals.length > 2) throw usage("Usage: wuapi wait <accountId | invitationId> [--timeout seconds]");
  const client = makeClient(ctx);
  const given = ctx.args.flags.has("timeout");
  let account: Account;
  try {
    ({ account } = await waitForAccount(ctx, client, id, { timeoutMs: numberFlag(ctx.args, "timeout", 300) * 1000, open: boolFlag(ctx.args, "open") }));
  } catch (e) {
    if (!(e instanceof WuapiError) || e.status !== 404) throw e;
    let first: Invitation;
    try {
      first = await getInvitation(ctx, client, id);
    } catch (e2) {
      if (e2 instanceof WuapiError && e2.status === 404) {
        throw new CliError("not_found", `No account or invitation ${id}.`, { details: { id } });
      }
      throw e2;
    }
    const { account: ready } = await waitForInvitation(ctx, client, id, { timeoutMs: (given ? numberFlag(ctx.args, "timeout", 900) : 900) * 1000, first });
    emit(ctx, invitationReadyJson(id, ready), () => readyText(ready));
    return;
  }
  emit(ctx, readyJson(account), () => readyText(account));
}

/** GET /v1/invitations/{id}, retrying transient failures a few times. */
async function getInvitation(ctx: Ctx, client: Wuapi, id: string): Promise<Invitation> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.invitations.get(id);
    } catch (e) {
      if (!isTransient(e) || attempt >= 5) throw e;
      await ctx.io.sleep(POLL_MS);
    }
  }
}
