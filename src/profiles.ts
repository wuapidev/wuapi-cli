// Stored logins: `wuapi profiles`, `wuapi switch`, `wuapi logout`, `wuapi whoami`.

import { allowOnly, boolFlag } from "./args.js";
import { credsPath, emit, makeClient, readCreds, resolveAuth, type Ctx } from "./context.js";
import { saveCredentials, type Credentials, type Profile } from "./credentials.js";
import { CliError, usage } from "./errors.js";
import { removeFile } from "./files.js";

const describe = (p: Profile) => (p.project ? `${p.organization.name} / ${p.project.name}` : p.organization.name);

function summary(name: string, p: Profile, current: string | null) {
  return {
    name,
    current: name === current,
    organization: p.organization,
    project: p.project,
    keyPrefix: p.keyPrefix ?? null,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    createdAt: p.createdAt,
  };
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n");
}

export function listProfiles(ctx: Ctx): void {
  allowOnly(ctx.args, []);
  const creds = readCreds(ctx);
  const names = Object.keys(creds.profiles);
  emit(ctx, { current: creds.current, profiles: names.map((n) => summary(n, creds.profiles[n]!, creds.current)) }, () => {
    if (names.length === 0) return "No profiles. Run `wuapi login`.";
    const rows = [["", "PROFILE", "ORGANIZATION", "PROJECT", "KEY"]];
    for (const n of names) {
      const p = creds.profiles[n]!;
      rows.push([n === creds.current ? "*" : "", n, p.organization.name, p.project?.name ?? "-", p.keyPrefix ? `${p.keyPrefix}...` : "-"]);
    }
    return table(rows);
  });
}

export async function switchProfile(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, []);
  const creds = readCreds(ctx);
  const names = Object.keys(creds.profiles);
  if (names.length === 0) throw new CliError("not_logged_in", "No profiles. Run `wuapi login`.");
  let name = ctx.args.positionals[1];
  if (ctx.args.positionals.length > 2) throw usage("Usage: wuapi switch [<profile>]");
  if (name === undefined) {
    if (!ctx.interactive) {
      throw new CliError("profile_required", `Name the profile: wuapi switch <profile>. Profiles: ${names.join(", ")}.`, { exitCode: 2, details: { profiles: names } });
    }
    const labels = names.map((n) => `${n}  (${describe(creds.profiles[n]!)})${n === creds.current ? "  *" : ""}`);
    const i = await ctx.io.pick("Switch to which profile? (arrows or a number, Enter)", labels, Math.max(0, names.indexOf(creds.current ?? "")));
    if (i === null) throw new CliError("cancelled", "Nothing changed.");
    name = names[i]!;
  }
  if (!creds.profiles[name]) {
    throw new CliError("profile_not_found", `No profile named "${name}". Profiles: ${names.join(", ")}.`, { details: { profiles: names } });
  }
  creds.current = name;
  saveCredentials(creds, credsPath(ctx));
  emit(ctx, { current: name, profile: summary(name, creds.profiles[name]!, name) }, () => `Now using ${name} (${describe(creds.profiles[name]!)}).`);
}

function nextCurrent(creds: Credentials): string | null {
  return Object.keys(creds.profiles)[0] ?? null;
}

export function logout(ctx: Ctx): void {
  allowOnly(ctx.args, ["all"]);
  if (ctx.args.positionals.length > 2) throw usage("Usage: wuapi logout [<profile>] [--all]");
  const creds = readCreds(ctx);
  const revoke = "The key still exists: revoke it at https://wuapi.dev/app/api-keys if nobody else uses it.";
  if (boolFlag(ctx.args, "all")) {
    const removed = Object.keys(creds.profiles);
    removeFile(credsPath(ctx));
    emit(ctx, { removed, current: null }, () => (removed.length ? `Logged out of ${removed.join(", ")}.\n${revoke}` : "No profiles to remove."));
    return;
  }
  const name = ctx.args.positionals[1] ?? creds.current;
  if (!name || !creds.profiles[name]) {
    if (ctx.args.positionals[1]) throw new CliError("profile_not_found", `No profile named "${name}".`, { details: { profiles: Object.keys(creds.profiles) } });
    emit(ctx, { removed: [], current: null }, () => "Not logged in.");
    return;
  }
  delete creds.profiles[name];
  const wasCurrent = creds.current === name;
  if (wasCurrent) creds.current = nextCurrent(creds);
  if (Object.keys(creds.profiles).length === 0) removeFile(credsPath(ctx));
  else saveCredentials(creds, credsPath(ctx));
  emit(ctx, { removed: [name], current: creds.current }, () =>
    [
      `Logged out of ${name}.`,
      ...(wasCurrent && creds.current ? [`Now using ${creds.current} (${describe(creds.profiles[creds.current]!)}).`] : []),
      revoke,
    ].join("\n"),
  );
}

export async function whoami(ctx: Ctx): Promise<void> {
  allowOnly(ctx.args, []);
  const auth = resolveAuth(ctx);
  const me = await makeClient(ctx, auth).me();
  const source = auth.source === "profile" ? `profile ${auth.profileName}` : auth.source === "flag" ? "--api-key" : auth.source === "env" ? "WUAPI_API_KEY" : "./.env";
  emit(
    ctx,
    {
      profile: auth.profileName ?? null,
      keySource: auth.source,
      organization: { id: me.organization.id, name: me.organization.name },
      project: me.project ? { id: me.project.id, name: me.project.name } : null,
      apiKey: { id: me.apiKey.id, name: me.apiKey.name, keyPrefix: me.apiKey.keyPrefix, last4: me.apiKey.last4 },
      baseUrl: auth.baseUrl,
    },
    () =>
      [
        `Organization: ${me.organization.name} (${me.organization.id})`,
        `Project:      ${me.project ? `${me.project.name} (${me.project.id})` : "none (whole organization)"}`,
        `Key:          ${me.apiKey.name} ${me.apiKey.keyPrefix}...${me.apiKey.last4}`,
        `From:         ${source}`,
      ].join("\n"),
  );
}
