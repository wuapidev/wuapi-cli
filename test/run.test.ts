import { describe, expect, it } from "vitest";
import { saveCredentials } from "../src/credentials.js";
import { credentialsPath } from "../src/paths.js";
import { KEY, KEY2, fakeIo, run } from "./helpers.js";

describe("wuapi run", () => {
  it("runs the command with the key in its environment only and exits with its code", async () => {
    const io = fakeIo({ env: { WUAPI_API_KEY: KEY, HOME_THING: "x" } });
    io.execCode = 3;
    const r = await run(io, "run", "--", "npm", "run", "dev", "--port", "3000");
    expect(r.code).toBe(3);
    expect(io.execs).toHaveLength(1);
    expect(io.execs[0]!.command).toBe("npm");
    expect(io.execs[0]!.args).toEqual(["run", "dev", "--port", "3000"]);
    expect(io.execs[0]!.env).toMatchObject({ WUAPI_API_KEY: KEY, HOME_THING: "x" });
    expect(io.execs[0]!.env.WUAPI_BASE_URL).toBeUndefined();
    expect(r.out + r.err).not.toContain(KEY);
  });

  it("uses --profile: its key, its project and its base URL", async () => {
    const io = fakeIo();
    saveCredentials(
      {
        version: 2,
        current: "acme",
        profiles: {
          acme: { apiKey: KEY, organization: { id: "org_1", name: "Acme" }, project: null, createdAt: "2026-01-01T00:00:00Z" },
          "beta/shop": { apiKey: KEY2, baseUrl: "http://localhost:3210", organization: { id: "org_2", name: "Beta" }, project: { id: "prj_b", name: "Shop" }, createdAt: "2026-01-01T00:00:00Z" },
        },
      },
      credentialsPath(io.env, io.platform, io.home),
    );
    expect((await run(io, "run", "--", "node", "app.js")).code).toBe(0);
    expect(io.execs[0]!.env.WUAPI_API_KEY).toBe(KEY);
    expect(io.execs[0]!.env.WUAPI_PROJECT).toBeUndefined();

    expect((await run(io, "run", "--profile", "beta/shop", "--", "node", "app.js")).code).toBe(0);
    expect(io.execs[1]!.env).toMatchObject({ WUAPI_API_KEY: KEY2, WUAPI_PROJECT: "prj_b", WUAPI_BASE_URL: "http://localhost:3210" });
  });

  it("needs a command, a login, and the command after --", async () => {
    const io = fakeIo({ env: { WUAPI_API_KEY: KEY } });
    expect((await run(io, "run")).code).toBe(2);
    const flag = await run(io, "run", "node", "--inspect", "app.js");
    expect(flag.code).toBe(2);
    expect(flag.err).toContain("wuapi run -- <command>");
    const none = await run(fakeIo(), "run", "--", "node", "app.js", "--json");
    expect(none.code).toBe(1);
    expect(none.err).toContain("not_logged_in");
    expect(io.execs).toEqual([]);
  });
});
