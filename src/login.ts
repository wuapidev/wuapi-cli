// `wuapi login`: the device authorization flow. The CLI asks the API for a
// code, the person approves it in the browser (signed in to wuapi), and the
// CLI polls until the API hands over a new API key, which is stored as a
// profile. Networks drop (mobile, residential): every request is bounded and a
// failed poll is simply retried until the code expires.

import { allowOnly, boolFlag, stringFlag } from "./args.js";
import {
  credsPath,
  emit,
  log,
  pendingPath,
  readCreds,
  resolveBaseUrl,
  type Ctx,
} from "./context.js";
import { defaultProfileName, saveCredentials, uniqueProfileName, type Named, type Profile } from "./credentials.js";
import { ensureGitignored, writeDotenvKey } from "./dotenv.js";
import { CliError, usage } from "./errors.js";
import { readJson, removeFile, writePrivateJson } from "./files.js";
import { DEFAULT_BASE_URL } from "@wuapidev/sdk";
import { VERSION } from "./version.js";

const REQUEST_TIMEOUT_MS = 15_000;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

interface Pending extends DeviceCode {
  baseUrl: string;
  /** Epoch ms. */
  expiresAt: number;
  createdAt: string;
}

export interface TokenGrant {
  apiKey: string;
  keyPrefix: string;
  organization: Named;
  project: Named | null;
}

type PostResult = { kind: "response"; status: number; body: unknown } | { kind: "network"; message: string };

async function post(ctx: Ctx, url: string, body: unknown): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await ctx.io.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": `wuapi-cli/${VERSION}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { kind: "response", status: res.status, body: parsed };
  } catch (e) {
    const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
    const message = controller.signal.aborted ? "request timed out" : typeof cause === "string" ? cause : e instanceof Error ? e.message : String(e);
    return { kind: "network", message };
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(body: unknown): string | undefined {
  const b = body as { error?: unknown; code?: unknown } | undefined;
  if (typeof b?.error === "string") return b.error;
  if (typeof (b?.error as { code?: unknown })?.code === "string") return (b!.error as { code: string }).code;
  if (typeof b?.code === "string") return b.code;
  return undefined;
}

function isDeviceCode(v: unknown): v is DeviceCode {
  const d = v as DeviceCode;
  return typeof d?.deviceCode === "string" && typeof d.userCode === "string" && typeof d.verificationUri === "string";
}

/** POST /cli/device/code, retried a few times on network errors and 5xx. */
export async function requestDeviceCode(ctx: Ctx, baseUrl: string): Promise<DeviceCode> {
  const attempts = 4;
  for (let i = 1; ; i++) {
    const r = await post(ctx, `${baseUrl}/cli/device/code`, { clientName: ctx.io.hostname });
    if (r.kind === "response" && r.status >= 200 && r.status < 300 && isDeviceCode(r.body)) {
      const d = r.body;
      return {
        ...d,
        verificationUriComplete: d.verificationUriComplete || d.verificationUri,
        expiresIn: Number(d.expiresIn) > 0 ? Number(d.expiresIn) : 600,
        interval: Number(d.interval) > 0 ? Number(d.interval) : 5,
      };
    }
    const retryable = r.kind === "network" || r.status >= 500;
    if (!retryable || i >= attempts) {
      if (r.kind === "network") throw new CliError("network_error", `Could not reach ${baseUrl}: ${r.message}.`);
      const message = (r.body as { message?: unknown } | undefined)?.message;
      throw new CliError(errorCode(r.body) ?? `http_${r.status}`, `Could not start the login: ${typeof message === "string" ? message : `HTTP ${r.status}`}`);
    }
    log(ctx, `wuapi: ${r.kind === "network" ? r.message : `HTTP ${r.status}`}; retrying...`);
    await ctx.io.sleep(1000 * i);
  }
}

/**
 * Polls POST /cli/device/token every `interval` seconds until the person
 * approves, denies, or the code expires. `slow_down` adds 5 s to the
 * interval; network errors, timeouts, 429 and 5xx just wait for the next poll.
 */
export async function pollForToken(ctx: Ctx, baseUrl: string, pending: { deviceCode: string; interval: number; expiresAt: number }): Promise<TokenGrant> {
  let interval = Math.max(1, pending.interval);
  let failures = 0;
  for (;;) {
    if (ctx.io.now() >= pending.expiresAt) {
      throw new CliError("expired_token", "The login code expired before it was approved. Run `wuapi login` again.");
    }
    await ctx.io.sleep(interval * 1000);
    const r = await post(ctx, `${baseUrl}/cli/device/token`, { deviceCode: pending.deviceCode });
    if (r.kind === "network") {
      failures++;
      if (failures === 1 || failures % 5 === 0) log(ctx, `wuapi: ${r.message}; still waiting...`);
      continue;
    }
    if (r.status === 200) {
      const g = r.body as TokenGrant;
      if (typeof g?.apiKey !== "string" || typeof g.organization?.id !== "string") {
        throw new CliError("invalid_response", "The API answered the login with an unexpected body.");
      }
      return { apiKey: g.apiKey, keyPrefix: g.keyPrefix, organization: g.organization, project: g.project ?? null };
    }
    const code = errorCode(r.body);
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      if (code === "authorization_pending") continue;
      if (code === "slow_down") {
        interval += 5;
        continue;
      }
      if (code === "expired_token") throw new CliError("expired_token", "The login code expired before it was approved. Run `wuapi login` again.");
      if (code === "access_denied") throw new CliError("access_denied", "The login was denied in the browser.");
      if (code === "invalid_grant") throw new CliError("invalid_grant", "The login code is not valid (already used, or unknown). Run `wuapi login` again.");
    }
    if (r.status === 429 || r.status >= 500) {
      failures++;
      if (r.status === 429) interval += 5;
      continue;
    }
    throw new CliError(code ?? `http_${r.status}`, `The login failed (HTTP ${r.status}${code ? `, ${code}` : ""}).`);
  }
}

function codeText(code: DeviceCode, finishHint: boolean): string {
  return [
    "",
    `  Open:  ${code.verificationUriComplete}`,
    `  Code:  ${code.userCode}`,
    "",
    finishHint ? "Approve it in the browser, then run `wuapi login --finish`." : "Approve it in the browser to finish. Waiting...",
  ].join("\n");
}

/** Stores the new key as a profile (current), plus ./.env with --env. Never prints the key. */
function finish(ctx: Ctx, baseUrl: string, grant: TokenGrant): void {
  const creds = readCreds(ctx);
  const profile: Profile = {
    apiKey: grant.apiKey,
    ...(baseUrl !== DEFAULT_BASE_URL ? { baseUrl } : {}),
    organization: { id: grant.organization.id, name: grant.organization.name },
    project: grant.project ? { id: grant.project.id, name: grant.project.name } : null,
    ...(grant.keyPrefix ? { keyPrefix: grant.keyPrefix } : {}),
    createdAt: new Date(ctx.io.now()).toISOString(),
  };
  const explicit = stringFlag(ctx.args, "profile");
  const name = explicit ?? uniqueProfileName(creds, defaultProfileName(profile.organization, profile.project), profile);
  creds.profiles[name] = profile;
  creds.current = name;
  saveCredentials(creds, credsPath(ctx));

  let envFile: string | undefined;
  let gitignored = false;
  if (boolFlag(ctx.args, "env")) {
    envFile = writeDotenvKey(ctx.io.cwd, grant.apiKey);
    gitignored = ensureGitignored(ctx.io.cwd);
  }
  const where = profile.project ? `${profile.organization.name} / ${profile.project.name}` : profile.organization.name;
  emit(
    ctx,
    {
      profile: name,
      organization: profile.organization,
      project: profile.project,
      keyPrefix: grant.keyPrefix ?? null,
      credentialsPath: credsPath(ctx),
      ...(envFile ? { envFile } : {}),
    },
    () =>
      [
        `Logged in to ${where} (profile ${name}).`,
        `Key ${grant.keyPrefix ?? ""}... saved to ${credsPath(ctx)}.`,
        ...(envFile ? [`WUAPI_API_KEY written to ${envFile}${gitignored ? " (.env added to .gitignore)" : ""}.`] : []),
      ].join("\n"),
  );
}

export async function login(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, ["env", "no-browser", "start", "finish"]);
  if (ctx.args.positionals.length > 1) throw usage("wuapi login takes no arguments.");
  const start = boolFlag(ctx.args, "start");
  const fin = boolFlag(ctx.args, "finish");
  if (start && fin) throw usage("Use --start or --finish, not both.");
  const path = pendingPath(ctx);

  if (fin) {
    const pending = readJson(path) as Pending | undefined;
    if (!pending?.deviceCode) throw new CliError("no_pending_login", `No login is waiting in this folder (${ctx.io.cwd}). Run \`wuapi login --start\` here first; --finish must run in the same folder.`);
    if (ctx.io.now() >= pending.expiresAt) {
      removeFile(path);
      throw new CliError("expired_token", "The login code expired before it was approved. Run `wuapi login --start` again.");
    }
    log(ctx, `Waiting for approval of code ${pending.userCode} (${pending.verificationUriComplete})...`);
    try {
      const grant = await pollForToken(ctx, pending.baseUrl, pending);
      removeFile(path);
      finish(ctx, pending.baseUrl, grant);
    } catch (e) {
      if (e instanceof CliError && ["expired_token", "access_denied", "invalid_grant"].includes(e.code)) removeFile(path);
      throw e;
    }
    return;
  }

  const baseUrl = resolveBaseUrl(ctx);
  const code = await requestDeviceCode(ctx, baseUrl);
  const expiresAt = ctx.io.now() + code.expiresIn * 1000;
  if (!boolFlag(ctx.args, "no-browser")) ctx.io.open(code.verificationUriComplete);

  if (start) {
    const pending: Pending = { ...code, baseUrl, expiresAt, createdAt: new Date(ctx.io.now()).toISOString() };
    writePrivateJson(path, pending);
    emit(ctx, { url: code.verificationUriComplete, code: code.userCode, expiresIn: code.expiresIn }, () => codeText(code, true));
    return;
  }

  log(ctx, codeText(code, false));
  const grant = await pollForToken(ctx, baseUrl, { deviceCode: code.deviceCode, interval: code.interval, expiresAt });
  finish(ctx, baseUrl, grant);
}
