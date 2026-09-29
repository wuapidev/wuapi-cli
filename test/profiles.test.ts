import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultProfileName, loadCredentials, slug, uniqueProfileName, type Credentials, type Profile } from "../src/credentials.js";
import { configDir, credentialsPath } from "../src/paths.js";
import { KEY, KEY2, fakeIo, mockFetch, run } from "./helpers.js";

const profile = (apiKey: string, org: string, project: { id: string; name: string } | null = null): Profile => ({
  apiKey,
  organization: { id: `org_${org}`, name: org },
  project,
  keyPrefix: apiKey.slice(0, 12),
  createdAt: "2026-09-29T00:00:00.000Z",
});

function seed(io: ReturnType<typeof fakeIo>, creds: unknown) {
  const path = credentialsPath(io.env, io.platform, io.home);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(creds));
  return path;
}

const ME = (name: string) => ({
  object: "auth_context",
  organization: { object: "organization", id: `org_${name}`, name },
  apiKey: { object: "api_key", id: "key_1", name: "cli", projectId: null, keyPrefix: "wu_live_abcd", last4: "1234", createdAt: "", lastUsedAt: null, revokedAt: null },
  project: null,
});

describe("paths", () => {
  it("follows XDG_CONFIG_HOME, ~/.config and %APPDATA%", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux", "/home/u")).toBe("/x/cfg/wuapi");
    expect(configDir({ XDG_CONFIG_HOME: "relative" }, "linux", "/home/u")).toBe("/home/u/.config/wuapi");
    expect(configDir({}, "darwin", "/Users/u")).toBe("/Users/u/.config/wuapi");
    expect(credentialsPath({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\wuapi\\credentials.json");
  });
});

describe("credentials file", () => {
  it("migrates a version-1 file in place to a profile", () => {
    const io = fakeIo();
    const path = seed(io, { version: 1, apiKey: KEY, organization: { id: "org_1", name: "Acme" }, project: { id: "prj_1", name: "Store 1" }, createdAt: "2026-01-01T00:00:00Z" });
    const creds = loadCredentials(path);
    expect(creds).toEqual({
      version: 2,
      current: "acme/store-1",
      profiles: { "acme/store-1": { apiKey: KEY, organization: { id: "org_1", name: "Acme" }, project: { id: "prj_1", name: "Store 1" }, createdAt: "2026-01-01T00:00:00Z" } },
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(creds);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("slugs names and dedupes", () => {
    expect(slug("Ñandú Café & Co.")).toBe("nandu-cafe-co");
    expect(slug("!!!")).toBe("default");
    expect(defaultProfileName({ id: "o", name: "Acme" }, { id: "p", name: "Store 1" })).toBe("acme/store-1");
    const creds: Credentials = { version: 2, current: "acme", profiles: { acme: profile(KEY, "Acme"), "acme-2": profile(KEY, "Other") } };
    expect(uniqueProfileName(creds, "acme", profile(KEY2, "Acme"))).toBe("acme");
    expect(uniqueProfileName(creds, "acme", { ...profile(KEY2, "Acme"), organization: { id: "org_new", name: "Acme" } })).toBe("acme-3");
  });
});

describe("profiles, switch, logout", () => {
  const two = { version: 2, current: "acme", profiles: { acme: profile(KEY, "Acme"), "beta/shop": profile(KEY2, "Beta", { id: "prj_b", name: "Shop" }) } };

  it("lists profiles with the current one marked", async () => {
    const io = fakeIo();
    seed(io, two);
    const r = await run(io, "profiles");
    expect(r.out).toMatch(/^\s+PROFILE/);
    expect(r.out).toMatch(/^\*\s+acme\s/m);
    expect(r.out).not.toContain(KEY);
    const j = await run(io, "profile", "list", "--json");
    expect(j.json.current).toBe("acme");
    expect(j.json.profiles.map((p: { name: string }) => p.name)).toEqual(["acme", "beta/shop"]);
    expect(JSON.stringify(j.json)).not.toContain(KEY);
  });

  it("switches by name, lists names without a TTY, and picks in a TTY", async () => {
    const io = fakeIo();
    const path = seed(io, two);
    expect((await run(io, "switch", "beta/shop")).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).current).toBe("beta/shop");
    const noName = await run(io, "switch", "--json");
    expect(noName.code).toBe(2);
    expect(noName.json.error).toMatchObject({ code: "profile_required", details: { profiles: ["acme", "beta/shop"] } });
    expect((await run(io, "switch", "nope", "--json")).json.error.code).toBe("profile_not_found");

    const tty = fakeIo({ configHome: io.env.XDG_CONFIG_HOME!, stdinIsTTY: true, pick: async () => 0 });
    tty.home = io.home;
    expect((await run(tty, "switch")).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).current).toBe("acme");
  });

  it("logout of the current profile makes another current; --all removes the file", async () => {
    const io = fakeIo();
    const path = seed(io, two);
    const r = await run(io, "logout");
    expect(r.out).toContain("Now using beta/shop");
    expect(r.out).toContain("https://wuapi.dev/app/api-keys");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ current: "beta/shop", profiles: { "beta/shop": {} } });
    const j = await run(io, "logout", "beta/shop", "--json");
    expect(j.json).toEqual({ removed: ["beta/shop"], current: null });
    expect(existsSync(path)).toBe(false);
    seed(io, two);
    expect((await run(io, "logout", "--all", "--json")).json.removed).toEqual(["acme", "beta/shop"]);
    expect(existsSync(path)).toBe(false);
  });

  it("key precedence: --api-key > WUAPI_API_KEY > ./.env > --profile / WUAPI_PROFILE > current", async () => {
    const FLAG = "wu_live_flagflagflagflagflag";
    const ENV = "wu_live_envenvenvenvenvenv1";
    const DOT = "wu_live_dotdotdotdotdotdot1";
    const { fetch, calls } = mockFetch({ "GET /v1/me": [{ body: ME("Acme") }] });
    const lastKey = () => calls.at(-1)!.headers.authorization!.replace("Bearer ", "");
    const lastProject = () => calls.at(-1)!.headers["wuapi-project"];

    const io = fakeIo({ fetch });
    seed(io, two);
    await run(io, "whoami");
    expect(lastKey()).toBe(KEY);
    expect((await run(io, "whoami", "--json")).json.profile).toBe("acme");
    await run(io, "whoami", "--profile", "beta/shop");
    expect(lastKey()).toBe(KEY2);
    expect(lastProject()).toBe("prj_b");
    io.env.WUAPI_PROFILE = "beta/shop";
    await run(io, "whoami");
    expect(lastKey()).toBe(KEY2);
    writeFileSync(join(io.cwd, ".env"), `WUAPI_API_KEY="${DOT}"\n`);
    await run(io, "whoami");
    expect(lastKey()).toBe(DOT);
    expect(lastProject()).toBeUndefined();
    io.env.WUAPI_API_KEY = ENV;
    await run(io, "whoami");
    expect(lastKey()).toBe(ENV);
    const r = await run(io, "whoami", "--api-key", FLAG, "--profile", "acme", "--project", "prj_x");
    expect(lastKey()).toBe(FLAG);
    expect(lastProject()).toBe("prj_x");
    expect(r.err).toContain("--profile ignored");
  });

  it("asks to log in when there is no key, and never echoes a malformed one", async () => {
    const io = fakeIo();
    const r = await run(io, "whoami", "--json");
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("not_logged_in");
    const bad = await run(io, "whoami", "--json", "--api-key", "sk_live_secretvalue");
    expect(bad.json.error.code).toBe("invalid_api_key");
    expect(bad.out).not.toContain("secretvalue");
    expect((await run(io, "whoami", "--json", "--profile", "ghost")).json.error.code).toBe("profile_not_found");
  });
});
