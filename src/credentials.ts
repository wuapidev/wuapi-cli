// The stored logins: several profiles (an organization, or one project of it),
// one of them current. `wuapi login` adds one; `--profile` / WUAPI_PROFILE pick
// one for a command; `wuapi switch` changes the current one.
//
// File (0600): { version: 2, current, profiles: { <name>: Profile } }. A
// version-1 file (one login, written by 0.0.x previews) is read and migrated
// in place.

import { credentialsPath } from "./paths.js";
import { readJson, writePrivateJson } from "./files.js";

export interface Named {
  id: string;
  name: string;
}

export interface Profile {
  apiKey: string;
  baseUrl?: string;
  organization: Named;
  project: Named | null;
  keyPrefix?: string;
  createdAt: string;
}

export interface Credentials {
  version: 2;
  current: string | null;
  profiles: Record<string, Profile>;
}

export const EMPTY: Credentials = { version: 2, current: null, profiles: {} };

/** `Acme Corp` -> `acme-corp`. Accents dropped; never empty. */
export function slug(text: string): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "default";
}

/** `acme`, or `acme/store-1` for a login scoped to a project. */
export function defaultProfileName(organization: Named, project: Named | null): string {
  return project ? `${slug(organization.name)}/${slug(project.name)}` : slug(organization.name);
}

/**
 * The name a new login gets: `wanted` when free or when it holds the same
 * organization and project (a re-login replaces it), else `wanted-2`, `-3`...
 */
export function uniqueProfileName(creds: Credentials, wanted: string, profile: Profile): string {
  const same = (p: Profile | undefined) =>
    p !== undefined && p.organization.id === profile.organization.id && (p.project?.id ?? null) === (profile.project?.id ?? null);
  if (!creds.profiles[wanted] || same(creds.profiles[wanted])) return wanted;
  for (let i = 2; ; i++) {
    const name = `${wanted}-${i}`;
    if (!creds.profiles[name] || same(creds.profiles[name])) return name;
  }
}

function isProfile(v: unknown): v is Profile {
  const p = v as Profile;
  return typeof p === "object" && p !== null && typeof p.apiKey === "string" && typeof p.organization?.id === "string";
}

/** Reads the file, migrating a version-1 file in place. Missing file: no profiles. */
export function loadCredentials(path: string = credentialsPath()): Credentials {
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch {
    throw Object.assign(new Error(`${path} is not valid JSON. Delete it and run \`npx @wuapidev/cli login\` again.`), { code: "invalid_credentials" });
  }
  if (raw === undefined) return { ...EMPTY, profiles: {} };
  const r = raw as { version?: number; current?: unknown; profiles?: Record<string, unknown> };
  if (r.version === 2 && typeof r.profiles === "object" && r.profiles !== null) {
    const profiles: Record<string, Profile> = {};
    for (const [name, p] of Object.entries(r.profiles)) if (isProfile(p)) profiles[name] = p;
    const current = typeof r.current === "string" && profiles[r.current] ? r.current : (Object.keys(profiles)[0] ?? null);
    return { version: 2, current, profiles };
  }
  if (r.version === 1 && isProfile(raw)) {
    const v1 = raw as Profile & { version: 1 };
    const profile: Profile = {
      apiKey: v1.apiKey,
      ...(v1.baseUrl ? { baseUrl: v1.baseUrl } : {}),
      organization: v1.organization,
      project: v1.project ?? null,
      ...(v1.keyPrefix ? { keyPrefix: v1.keyPrefix } : {}),
      createdAt: v1.createdAt ?? new Date().toISOString(),
    };
    const name = defaultProfileName(profile.organization, profile.project);
    const migrated: Credentials = { version: 2, current: name, profiles: { [name]: profile } };
    try {
      writePrivateJson(path, migrated);
    } catch {
      // Read-only config: use the migrated form in memory.
    }
    return migrated;
  }
  throw Object.assign(new Error(`${path} has an unknown format. Delete it and run \`npx @wuapidev/cli login\` again.`), { code: "invalid_credentials" });
}

export function saveCredentials(creds: Credentials, path: string = credentialsPath()): void {
  writePrivateJson(path, creds);
}
