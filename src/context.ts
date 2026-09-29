// What every command gets: the IO, the parsed arguments, the output mode, and
// the API key / base URL / project resolved from flags, environment, ./.env
// and the stored profiles.

import { DEFAULT_BASE_URL, Wuapi } from "@wuapidev/sdk";
import type { Parsed } from "./args.js";
import { stringFlag } from "./args.js";
import { loadCredentials, type Credentials, type Profile } from "./credentials.js";
import { readDotenvKey } from "./dotenv.js";
import { CliError, usage } from "./errors.js";
import type { Io } from "./io.js";
import { credentialsPath, pendingLoginPath } from "./paths.js";

export interface Ctx {
  io: Io;
  args: Parsed;
  /** --json: results as JSON on stdout, everything else on stderr. */
  json: boolean;
  /** A person at a terminal: no --json and stdin is a TTY. Only then may a command ask. */
  interactive: boolean;
}

export function makeCtx(io: Io, args: Parsed): Ctx {
  const json = args.flags.get("json") !== undefined;
  return { io, args, json, interactive: !json && io.stdinIsTTY };
}

export const log = (ctx: Ctx, text: string) => ctx.io.err(`${text}\n`);

/** Prints a result: JSON with --json, else the human text. */
export function emit(ctx: Ctx, value: unknown, human: () => string): void {
  if (ctx.json) ctx.io.out(`${JSON.stringify(value ?? { ok: true }, null, 2)}\n`);
  else {
    const text = human();
    if (text) ctx.io.out(text.endsWith("\n") ? text : `${text}\n`);
  }
}

export const credsPath = (ctx: Ctx) => credentialsPath(ctx.io.env, ctx.io.platform, ctx.io.home);
export const pendingPath = (ctx: Ctx) => pendingLoginPath(ctx.io.env, ctx.io.platform, ctx.io.home, ctx.io.cwd);

export function readCreds(ctx: Ctx): Credentials {
  try {
    return loadCredentials(credsPath(ctx));
  } catch (e) {
    throw new CliError("invalid_credentials", (e as Error).message);
  }
}

/** Plain https, or http on this machine only: the key must never travel in clear text. */
export function isSafeBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/** --base-url > WUAPI_BASE_URL > the profile's > https://api.wuapi.dev. */
export function resolveBaseUrl(ctx: Ctx, profile?: Profile): string {
  const value = stringFlag(ctx.args, "base-url") ?? (ctx.io.env.WUAPI_BASE_URL?.trim() || undefined) ?? profile?.baseUrl ?? DEFAULT_BASE_URL;
  if (!isSafeBaseUrl(value)) throw usage("The base URL must be https (or http://localhost for development).");
  return value.replace(/\/+$/, "");
}

export type KeySource = "flag" | "env" | "dotenv" | "profile";

export interface Auth {
  apiKey: string;
  baseUrl: string;
  project?: string;
  source: KeySource;
  /** The stored profile the key came from. */
  profileName?: string;
  profile?: Profile;
}

const KEY_RE = /^wu_(live|test)_[A-Za-z0-9]{16,128}$/;

/** The profile named by --profile or WUAPI_PROFILE, else the current one. */
export function selectedProfile(ctx: Ctx, creds: Credentials): { name: string; profile: Profile } | undefined {
  const wanted = stringFlag(ctx.args, "profile") ?? (ctx.io.env.WUAPI_PROFILE?.trim() || undefined);
  if (wanted !== undefined) {
    const profile = creds.profiles[wanted];
    if (!profile) {
      const names = Object.keys(creds.profiles);
      throw new CliError("profile_not_found", `No profile named "${wanted}".${names.length ? ` Profiles: ${names.join(", ")}.` : " Run `npx @wuapidev/cli login`."}`, {
        details: { profiles: names },
      });
    }
    return { name: wanted, profile };
  }
  if (creds.current && creds.profiles[creds.current]) return { name: creds.current, profile: creds.profiles[creds.current]! };
  return undefined;
}

/**
 * The key: --api-key > WUAPI_API_KEY > WUAPI_API_KEY in ./.env >
 * --profile / WUAPI_PROFILE > the current profile.
 */
export function resolveAuth(ctx: Ctx): Auth {
  const flag = stringFlag(ctx.args, "api-key");
  const env = ctx.io.env.WUAPI_API_KEY?.trim() || undefined;
  const dotenv = flag || env ? undefined : readDotenvKey(ctx.io.cwd);
  let apiKey = flag ?? env ?? dotenv;
  let source: KeySource = flag ? "flag" : env ? "env" : "dotenv";
  let chosen: { name: string; profile: Profile } | undefined;
  if (!apiKey) {
    chosen = selectedProfile(ctx, readCreds(ctx));
    if (chosen) {
      apiKey = chosen.profile.apiKey;
      source = "profile";
    }
  } else if (stringFlag(ctx.args, "profile") !== undefined) {
    log(ctx, `wuapi: --profile ignored: the key comes from ${source === "flag" ? "--api-key" : source === "env" ? "WUAPI_API_KEY" : "./.env"}.`);
  }
  if (!apiKey) {
    throw new CliError("not_logged_in", "No API key. Run `npx @wuapidev/cli login`, or set WUAPI_API_KEY (create a key at https://wuapi.dev/app/api-keys).");
  }
  if (!KEY_RE.test(apiKey)) {
    const where = source === "flag" ? "--api-key" : source === "env" ? "WUAPI_API_KEY" : source === "dotenv" ? "WUAPI_API_KEY in ./.env" : `profile ${chosen?.name}`;
    throw new CliError("invalid_api_key", `${where} does not look like a wuapi API key (wu_live_...).`);
  }
  const project = stringFlag(ctx.args, "project") ?? (ctx.io.env.WUAPI_PROJECT?.trim() || undefined) ?? (source === "profile" ? chosen?.profile.project?.id : undefined);
  return {
    apiKey,
    baseUrl: resolveBaseUrl(ctx, chosen?.profile),
    ...(project ? { project } : {}),
    source,
    ...(chosen ? { profileName: chosen.name, profile: chosen.profile } : {}),
  };
}

export function makeClient(ctx: Ctx, auth: Auth = resolveAuth(ctx)): Wuapi {
  return new Wuapi({
    apiKey: auth.apiKey,
    baseUrl: auth.baseUrl,
    ...(auth.project ? { project: auth.project } : {}),
    fetch: ctx.io.fetch,
  });
}
