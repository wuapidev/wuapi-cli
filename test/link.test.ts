import { describe, expect, it } from "vitest";
import { countryFromPhone, normalizePhone } from "../src/dialcodes.js";
import { KEY, fakeIo, mockFetch, run } from "./helpers.js";

const account = (over: Record<string, unknown> = {}) => ({
  object: "account",
  id: "acc_1",
  projectId: null,
  name: null,
  status: "initializing",
  reconnecting: false,
  phone: null,
  profileName: null,
  proxyLocation: { object: "proxy_location", country: "VE", countryName: "Venezuela", city: "caracas", cityName: "Caracas" },
  qrCodeUrl: null,
  pairingCode: null,
  pairingCodeExpiresAt: null,
  billable: false,
  disconnectReason: null,
  lastError: null,
  ...over,
});
const location = (country: string, city: string) => ({ object: "proxy_location", country, countryName: country, city, cityName: city });
const page = (items: unknown[]) => ({ body: { object: "list", items, nextCursor: null } });
const env = { WUAPI_API_KEY: KEY };

describe("phone numbers", () => {
  it("normalizes and maps dial codes to countries", () => {
    expect(normalizePhone("+58 412-123 4567")).toBe("+584121234567");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("hello")).toBeUndefined();
    expect(countryFromPhone("+584121234567")).toBe("VE");
    expect(countryFromPhone("+14155550123")).toBe("US");
    expect(countryFromPhone("+18095550123")).toBe("DO");
    expect(countryFromPhone("+5511999998888")).toBe("BR");
  });
});

describe("wuapi link", () => {
  it("links by pairing code: country from the phone, biggest city, one idempotency key, waits through a drop", async () => {
    const { fetch, calls } = mockFetch({
      "GET /v1/proxy-locations": [page([location("VE", "caracas")])],
      "POST /v1/accounts": [{ status: 201, body: account() }],
      "GET /v1/accounts/acc_1": [
        { body: account() },
        { body: account({ status: "qr_ready", pairingCode: "ABCD-1234" }) },
        new Error("socket hang up"),
        { status: 502, body: { code: "bad_gateway", message: "Bad gateway." } },
        { body: account({ status: "authenticating", pairingCode: "ABCD-1234" }) },
        { body: account({ status: "ready", phone: "+584121234567", profileName: "Ana" }) },
      ],
    });
    const io = fakeIo({ fetch, env });
    const r = await run(io, "link", "--phone", "+58 412 1234567", "--name", "Support");
    expect(r.code).toBe(0);
    expect(r.out).toContain("ABCD-1234");
    expect(r.out).toContain("Link with phone number instead");
    expect(r.out).toContain("Linked +584121234567 (Ana). Account acc_1 is ready.");
    const list = calls.find((c) => c.path === "/v1/proxy-locations")!;
    expect(new URL(list.url).searchParams.get("country")).toBe("VE");
    expect(new URL(list.url).searchParams.get("limit")).toBe("1");
    const creates = calls.filter((c) => c.method === "POST" && c.path === "/v1/accounts");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toEqual({ proxyLocation: { country: "VE", city: "caracas" }, name: "Support", pairingPhone: "+584121234567" });
    expect(creates[0]!.headers["idempotency-key"]).toMatch(/[0-9a-f-]{36}/);
    expect(io.sleeps.every((ms) => ms === 2000)).toBe(true);
  });

  it("resolves --city with a search, and needs --country without a phone", async () => {
    const { fetch, calls } = mockFetch({
      "GET /v1/proxy-locations": [page([location("CO", "bogotá")])],
      "POST /v1/accounts": [{ status: 201, body: account() }],
      "GET /v1/accounts/acc_1": [{ body: account({ status: "qr_ready", qrCodeUrl: "data:image/png;base64,AAAA" }) }],
    });
    const io = fakeIo({ fetch, env });
    const missing = await run(io, "link", "--json");
    expect(missing.code).toBe(2);
    expect(missing.json.error.code).toBe("missing_country");
    const r = await run(io, "link", "--country", "co", "--city", "bogota", "--no-wait", "--json");
    expect(r.code).toBe(0);
    const q = new URL(calls.find((c) => c.path === "/v1/proxy-locations")!.url).searchParams;
    expect([q.get("q"), q.get("country")]).toEqual(["bogota", "CO"]);
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ proxyLocation: { country: "CO", city: "bogotá" } });
    expect(r.json).toMatchObject({ accountId: "acc_1", status: "qr_ready", qrCodeUrl: "data:image/png;base64,AAAA" });
    expect(r.json.qrCodeFile).toMatch(/wuapi-qr-acc_1\.png$/);
  });

  it("fails when no proxy location matches", async () => {
    const { fetch } = mockFetch({ "GET /v1/proxy-locations": [page([])] });
    const r = await run(fakeIo({ fetch, env }), "link", "--country", "VE", "--city", "atlantis", "--json");
    expect(r.json.error.code).toBe("unsupported_proxy_location");
  });

  it("stops on terminal states and on the timeout", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ status: "failed", lastError: "boom" }, "account_failed"],
      [{ status: "disconnected", disconnectReason: "link_timeout" }, "account_link_timeout"],
      [{ status: "disconnected", disconnectReason: "logged_out" }, "account_logged_out"],
    ];
    for (const [state, code] of cases) {
      const { fetch } = mockFetch({ "GET /v1/accounts/acc_1": [{ body: account(state) }] });
      const r = await run(fakeIo({ fetch, env }), "wait", "acc_1", "--json");
      expect(r.code).toBe(1);
      expect(r.json.error.code).toBe(code);
    }
    const { fetch } = mockFetch({ "GET /v1/accounts/acc_1": [{ body: account({ status: "disconnected", reconnecting: true, disconnectReason: "logged_out" }) }] });
    const io = fakeIo({ fetch, env });
    const r = await run(io, "wait", "acc_1", "--timeout", "10", "--json");
    expect(r.json.error).toMatchObject({ code: "wait_timeout", details: { accountId: "acc_1", status: "disconnected" } });
    expect(io.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });

  it("wait returns the ready account as JSON", async () => {
    const { fetch } = mockFetch({ "GET /v1/accounts/acc_1": [{ body: account({ status: "ready", phone: "+1415" }) }] });
    const r = await run(fakeIo({ fetch, env }), "wait", "acc_1", "--json");
    expect(r.json).toMatchObject({ accountId: "acc_1", status: "ready", phone: "+1415" });
  });
});
