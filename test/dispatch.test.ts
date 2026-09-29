import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Wuapi } from "@wuapidev/sdk";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { makeCtx } from "../src/context.js";
import { buildCall, coerce, findOperation, sdkMethod } from "../src/dispatch.js";
import { OPERATIONS } from "../src/generated/operations.js";
import { KEY, fakeIo, mockFetch, run } from "./helpers.js";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));

/** Parameter names of a compiled method: `get(messageId, options)` -> ["messageId", "options"]. */
function paramNames(fn: Function): string[] {
  const m = /^[^(]*\(([^)]*)\)/.exec(fn.toString());
  return m![1]!
    .split(",")
    .map((p) => p.trim().replace(/\s*=.*$/, ""))
    .filter(Boolean);
}

describe("operations manifest", () => {
  it("is up to date with the spec and wuapi.sdk.toml", () => {
    const spec = join(pkgDir, "../../apps/wuapi/public/openapi.json");
    if (!existsSync(spec)) return; // The public mirror has no spec: the monorepo checks it.
    execFileSync(process.execPath, [join(pkgDir, "scripts/gen-operations.mjs"), "--check"], { stdio: "pipe" });
  });

  it("covers every operation once", () => {
    const ids = OPERATIONS.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(100);
    const spec = join(pkgDir, "../../apps/wuapi/public/openapi.json");
    if (!existsSync(spec)) return;
    const paths = JSON.parse(readFileSync(spec, "utf8")).paths as Record<string, Record<string, { operationId?: string }>>;
    const specIds = Object.values(paths).flatMap((item) => ["get", "post", "put", "patch", "delete"].flatMap((m) => (item[m]?.operationId ? [item[m]!.operationId!] : [])));
    expect([...ids].sort()).toEqual([...specIds].sort());
  });

  it("resolves every entry to an SDK method whose parameters match: path ids, then params when it takes any, then options", () => {
    const client = new Wuapi({ apiKey: "wu_live_test" });
    for (const op of OPERATIONS) {
      const label = [...op.resource, op.method].join(".");
      const fn = sdkMethod(client, op);
      expect(typeof fn, label).toBe("function");
      let target: any = client;
      for (const seg of op.resource) target = target[seg];
      const names = paramNames(target[op.method]);
      const takesParams = op.hasBody || op.query.length > 0;
      expect(names, label).toEqual([...op.pathParams, ...(takesParams ? ["params"] : []), "options"]);
      expect(target[op.method].length, label).toBeLessThanOrEqual(names.length);
      if (op.paginated) expect(op.httpMethod, label).toBe("GET");
    }
  });
});

describe("resolving commands", () => {
  it("finds resources and methods in any spelling", () => {
    expect(findOperation(["messages", "list"]).op?.operationId).toBe("listMessages");
    expect(findOperation(["webhook-endpoints", "rotate-secret", "we_1"])).toMatchObject({ op: { operationId: "rotateWebhookEndpointSecret" }, used: 2 });
    expect(findOperation(["projects", "api-keys", "list", "prj_1"])).toMatchObject({ op: { operationId: "listProjectApiKeys" }, used: 3 });
    expect(findOperation(["projects.apiKeys", "create", "prj_1"])).toMatchObject({ op: { operationId: "createProjectApiKey" }, used: 2 });
    expect(findOperation(["accounts", "createPairingCode"]).op?.operationId).toBe("createPairingCode");
    expect(findOperation(["me"]).op?.operationId).toBe("getMe");
    expect(findOperation(["groups"])).toMatchObject({ resource: ["groups"], used: 1 });
    expect(findOperation(["nope"])).toEqual({ used: 0 });
  });

  it("coerces values: JSON when it parses, strings where the spec says string", () => {
    expect(coerce("5", "integer")).toBe(5);
    expect(coerce("true")).toBe(true);
    expect(coerce('["a","b"]')).toEqual(["a", "b"]);
    expect(coerce("hello")).toBe("hello");
    expect(coerce("584121234567", "string")).toBe("584121234567");
    expect(coerce("a,b", "string[]")).toEqual(["a", "b"]);
    expect(coerce("123", '"text" | "image"')).toBe("123");
  });

  it("builds positional ids and a params object from flags, dotted flags and --data", async () => {
    const io = fakeIo();
    writeFileSync(join(io.cwd, "body.json"), JSON.stringify({ name: "Group", description: "d", settings: { a: 1, b: 2 } }));
    const op = OPERATIONS.find((o) => o.operationId === "updateGroup")!;
    const ctx = makeCtx(io, parseArgs(["groups", "update", "acc_1", "1203@g.us", "--data", "@body.json", "--name", "New", "--settings.b", "3", "--json"]));
    expect(await buildCall(ctx, op, ["acc_1", "1203@g.us"])).toEqual({ ids: ["acc_1", "1203@g.us"], params: { name: "New", description: "d", settings: { a: 1, b: 3 } } });

    const get = OPERATIONS.find((o) => o.operationId === "getGroup")!;
    const byFlag = makeCtx(io, parseArgs(["groups", "get", "1203@g.us", "--accountId", "acc_1"]));
    expect(await buildCall(byFlag, get, ["1203@g.us"])).toEqual({ ids: ["acc_1", "1203@g.us"] });
    await expect(buildCall(makeCtx(io, parseArgs(["x", "--limit", "2"])), get, ["a", "b"])).rejects.toThrow(/takes no fields/);
    await expect(buildCall(makeCtx(io, parseArgs([])), get, ["a"])).rejects.toThrow(/Missing <groupId>/);
    await expect(buildCall(makeCtx(io, parseArgs([])), get, ["a", "b", "c"])).rejects.toThrow(/Unexpected argument/);
  });
});

describe("generic calls through the SDK", () => {
  const env = { WUAPI_API_KEY: KEY };
  const msg = (id: string) => ({ object: "message", id });

  it("lists one page by default and every page with --all", async () => {
    const { fetch, calls } = mockFetch({
      "GET /v1/messages": (call) =>
        new URL(call.url).searchParams.get("cursor") === "c2"
          ? { body: { object: "list", items: [msg("m3")], nextCursor: null } }
          : { body: { object: "list", items: [msg("m1"), msg("m2")], nextCursor: "c2" } },
    });
    const io = fakeIo({ fetch, env });
    const one = await run(io, "messages", "list", "--accountId", "acc_1", "--limit", "2", "--json");
    expect(one.json).toEqual({ object: "list", items: [msg("m1"), msg("m2")], nextCursor: "c2" });
    const q = new URL(calls[0]!.url).searchParams;
    expect([q.get("accountId"), q.get("limit")]).toEqual(["acc_1", "2"]);
    const all = await run(io, "messages", "list", "--all", "--json");
    expect(all.json.items.map((m: { id: string }) => m.id)).toEqual(["m1", "m2", "m3"]);
    const human = await run(io, "messages", "list");
    expect(human.out).toContain("--cursor c2");
  });

  it("sends ids in the path and flags in the body", async () => {
    const { fetch, calls } = mockFetch({ "POST /v1/messages/msg_1/react": [{ status: 204 }], "GET /v1/me": [{ body: { object: "auth_context" } }] });
    const io = fakeIo({ fetch, env });
    const r = await run(io, "messages", "react", "msg_1", "--emoji", "👍", "--json");
    expect(r.json).toEqual({ ok: true });
    expect(calls[0]!.body).toEqual({ emoji: "👍" });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect((await run(io, "me", "--json")).json).toEqual({ object: "auth_context" });
  });

  it("prints API errors as JSON with a non-zero exit", async () => {
    const { fetch } = mockFetch({ "GET /v1/messages/msg_x": [{ status: 404, body: { code: "not_found", message: "No such message." } }] });
    const r = await run(fakeIo({ fetch, env }), "messages", "get", "msg_x", "--json");
    expect(r.code).toBe(1);
    expect(r.json).toEqual({ error: { code: "not_found", message: "No such message.", status: 404 } });
  });

  it("shows help for commands, resources and methods", async () => {
    const io = fakeIo();
    expect((await run(io, "help")).out).toContain("webhook-endpoints");
    expect((await run(io, "help", "messages")).out).toContain("wuapi messages get <messageId>");
    const m = await run(io, "messages", "list", "--help");
    expect(m.out).toContain("--accountId string");
    expect((await run(io, "--version")).out).toMatch(/^\d+\.\d+\.\d+/);
    const bad = await run(io, "frobnicate", "--json");
    expect(bad.code).toBe(2);
    expect(bad.json.error.code).toBe("usage");
  });
});

describe("flags that are also API fields", () => {
  it("sends --profile as the privacy field, not as the profile to use", async () => {
    const { fetch, calls } = mockFetch({ "PATCH /v1/accounts/acc_1/privacy": [{ body: { object: "privacy_settings" } }] });
    const r = await run(fakeIo({ fetch, env: { WUAPI_API_KEY: KEY } }), "privacy", "update", "acc_1", "--profile", "contacts", "--json");
    expect(r.code).toBe(0);
    expect(calls[0]!.body).toEqual({ profile: "contacts" });
  });
});
