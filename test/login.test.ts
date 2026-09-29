import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, pendingLoginPath } from "../src/paths.js";
import { KEY, fakeIo, mockFetch, run } from "./helpers.js";

const CODE = {
  deviceCode: "dev_123",
  userCode: "ABCD-EFGH",
  verificationUri: "https://wuapi.dev/cli",
  verificationUriComplete: "https://wuapi.dev/cli?user_code=ABCD-EFGH",
  expiresIn: 600,
  interval: 5,
};
const GRANT = { apiKey: KEY, keyPrefix: "wu_live_abcd", organization: { id: "org_1", name: "Acme Corp" }, project: null };
const pending = { status: 400, body: { error: "authorization_pending" } };

function creds(io: ReturnType<typeof fakeIo>) {
  return JSON.parse(readFileSync(credentialsPath(io.env, io.platform, io.home), "utf8"));
}

describe("wuapi login", () => {
  it("polls through pending, slow_down and a dropped request, then stores the key as a profile", async () => {
    const { fetch, calls } = mockFetch({
      "POST /cli/device/code": [{ body: CODE }],
      "POST /cli/device/token": [pending, { status: 400, body: { error: "slow_down" } }, new Error("socket hang up"), pending, { body: GRANT }],
    });
    const io = fakeIo({ fetch });
    const r = await run(io, "login", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ profile: "acme-corp", organization: { id: "org_1", name: "Acme Corp" }, project: null, keyPrefix: "wu_live_abcd" });
    expect(r.out).not.toContain(KEY);
    expect(r.err).not.toContain(KEY);
    expect(r.err).toContain("ABCD-EFGH");
    expect(io.opened).toEqual([CODE.verificationUriComplete]);
    expect(calls[0]!.body).toEqual({ clientName: "test-host" });
    expect(calls.filter((c) => c.path === "/cli/device/token").every((c) => (c.body as { deviceCode: string }).deviceCode === "dev_123")).toBe(true);
    // 5 s, then 5 s more after slow_down.
    expect(io.sleeps).toEqual([5000, 5000, 10000, 10000, 10000]);
    const file = creds(io);
    expect(file).toMatchObject({ version: 2, current: "acme-corp", profiles: { "acme-corp": { apiKey: KEY, keyPrefix: "wu_live_abcd", project: null } } });
    const path = credentialsPath(io.env, io.platform, io.home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("fails clearly on expired_token, access_denied and invalid_grant", async () => {
    for (const [error, code] of [["expired_token", "expired_token"], ["access_denied", "access_denied"], ["invalid_grant", "invalid_grant"]] as const) {
      const { fetch } = mockFetch({ "POST /cli/device/code": [{ body: CODE }], "POST /cli/device/token": [pending, { status: 400, body: { error } }] });
      const io = fakeIo({ fetch });
      const r = await run(io, "login", "--json", "--no-browser");
      expect(r.code).toBe(1);
      expect(r.json.error.code).toBe(code);
      expect(io.opened).toEqual([]);
      expect(existsSync(credentialsPath(io.env, io.platform, io.home))).toBe(false);
    }
  });

  it("gives up when the code expires while the network is down", async () => {
    const { fetch } = mockFetch({ "POST /cli/device/code": [{ body: { ...CODE, expiresIn: 30 } }], "POST /cli/device/token": [new Error("ECONNRESET")] });
    const io = fakeIo({ fetch });
    const r = await run(io, "login", "--json", "--no-browser");
    expect(r.json.error.code).toBe("expired_token");
    expect(io.sleeps.length).toBe(6);
  });

  it("retries the code request on a network error", async () => {
    const { fetch } = mockFetch({ "POST /cli/device/code": [new Error("ENOTFOUND"), { body: CODE }], "POST /cli/device/token": [{ body: GRANT }] });
    const io = fakeIo({ fetch });
    expect((await run(io, "login", "--json", "--no-browser")).code).toBe(0);
  });

  it("--start saves the code and exits; --finish waits for it", async () => {
    const { fetch } = mockFetch({ "POST /cli/device/code": [{ body: CODE }], "POST /cli/device/token": [pending, { body: { ...GRANT, project: { id: "prj_1", name: "Store 1" } } }] });
    const io = fakeIo({ fetch });
    const start = await run(io, "login", "--start", "--json");
    expect(start.code).toBe(0);
    expect(start.json).toEqual({ url: CODE.verificationUriComplete, code: "ABCD-EFGH", expiresIn: 600 });
    const pendingPath = pendingLoginPath(io.env, io.platform, io.home);
    expect(statSync(pendingPath).mode & 0o777).toBe(0o600);
    expect(io.sleeps).toEqual([]);

    const fin = await run(io, "login", "--finish", "--json");
    expect(fin.code).toBe(0);
    expect(fin.json.profile).toBe("acme-corp/store-1");
    expect(existsSync(pendingPath)).toBe(false);
    expect(creds(io).profiles["acme-corp/store-1"].project).toEqual({ id: "prj_1", name: "Store 1" });

    const again = await run(io, "login", "--finish", "--json");
    expect(again.json.error.code).toBe("no_pending_login");
  });

  it("--finish refuses an expired pending code", async () => {
    const { fetch } = mockFetch({ "POST /cli/device/code": [{ body: CODE }] });
    const io = fakeIo({ fetch });
    await run(io, "login", "--start", "--json");
    io.clock.t += 601_000;
    const r = await run(io, "login", "--finish", "--json");
    expect(r.json.error.code).toBe("expired_token");
    expect(existsSync(pendingLoginPath(io.env, io.platform, io.home))).toBe(false);
  });

  it("--env writes the key to ./.env once and ignores .env in git, without printing it", async () => {
    const { fetch } = mockFetch({ "POST /cli/device/code": [{ body: CODE }], "POST /cli/device/token": [{ body: GRANT }] });
    const io = fakeIo({ fetch });
    writeFileSync(join(io.cwd, ".env"), "OTHER=1\nWUAPI_API_KEY=wu_live_old\nexport WUAPI_API_KEY=dup\n");
    writeFileSync(join(io.cwd, ".gitignore"), "node_modules");
    const r = await run(io, "login", "--env", "--no-browser");
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain(KEY);
    expect(readFileSync(join(io.cwd, ".env"), "utf8")).toBe(`OTHER=1\nWUAPI_API_KEY=${KEY}\n`);
    expect(readFileSync(join(io.cwd, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
    await run(io, "login", "--env", "--no-browser");
    expect(readFileSync(join(io.cwd, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
  });

  it("names profiles after the organization, replaces a re-login and dedupes another organization of the same name", async () => {
    const grants = [GRANT, { ...GRANT, apiKey: `${KEY}x` }, { ...GRANT, organization: { id: "org_2", name: "Acme Corp" } }];
    let i = 0;
    const { fetch } = mockFetch({ "POST /cli/device/code": [{ body: CODE }], "POST /cli/device/token": () => ({ body: grants[Math.min(i++, 2)] }) });
    const io = fakeIo({ fetch });
    for (let n = 0; n < 3; n++) await run(io, "login", "--no-browser");
    const file = creds(io);
    expect(Object.keys(file.profiles)).toEqual(["acme-corp", "acme-corp-2"]);
    expect(file.profiles["acme-corp"].apiKey).toBe(`${KEY}x`);
    expect(file.current).toBe("acme-corp-2");
    await run(io, "login", "--no-browser", "--profile", "work");
    expect(creds(io).current).toBe("work");
  });
});
