import { describe, expect, it } from "vitest";
import { KEY, fakeIo, mockFetch, run } from "./helpers.js";

const msg = (status: string, over: Record<string, unknown> = {}) => ({ object: "message", id: "msg_1", accountId: "acc_1", chatId: "+584121234567", status, error: null, ...over });
const env = { WUAPI_API_KEY: KEY };

describe("wuapi send", () => {
  it("reuses one idempotency key when a send is cut off, and waits until delivered", async () => {
    const { fetch, calls } = mockFetch({
      "POST /v1/messages": [new Error("socket hang up"), { status: 201, body: msg("queued") }],
      "GET /v1/messages/msg_1": [{ body: msg("queued") }, new Error("ECONNRESET"), { body: msg("delivered") }],
    });
    const io = fakeIo({ fetch, env });
    const r = await run(io, "send", "+584121234567", "Hola", "--account", "acc_1", "--wait", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ id: "msg_1", status: "delivered" });
    const sends = calls.filter((c) => c.method === "POST");
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body).toEqual({ accountId: "acc_1", to: "+584121234567", text: "Hola" });
    expect(sends[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(sends[1]!.headers["idempotency-key"]).toBe(sends[0]!.headers["idempotency-key"]);
    expect(r.json.idempotencyKey).toBe(sends[0]!.headers["idempotency-key"]);
  });

  it("picks the only ready account, and asks for --account when there are several", async () => {
    const acc = (id: string, status = "ready") => ({ object: "account", id, status, phone: null, name: null });
    const one = mockFetch({
      "GET /v1/accounts": [{ body: { object: "list", items: [acc("acc_1"), acc("acc_2", "disconnected")], nextCursor: null } }],
      "POST /v1/messages": [{ status: 201, body: msg("queued") }],
    });
    const r = await run(fakeIo({ fetch: one.fetch, env }), "send", "+1415", "hi");
    expect(r.out).toBe("msg_1 queued\n");
    expect(one.calls.at(-1)!.body).toMatchObject({ accountId: "acc_1" });

    const many = mockFetch({ "GET /v1/accounts": [{ body: { object: "list", items: [acc("acc_1"), acc("acc_2")], nextCursor: null } }] });
    const r2 = await run(fakeIo({ fetch: many.fetch, env }), "send", "+1415", "hi", "--json");
    expect(r2.code).toBe(2);
    expect(r2.json.error.code).toBe("account_required");
    expect(many.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports a failed message with its error code", async () => {
    const { fetch } = mockFetch({
      "POST /v1/messages": [{ status: 201, body: msg("queued") }],
      "GET /v1/messages/msg_1": [{ body: msg("failed", { error: { code: "not_on_whatsapp", message: "The recipient is not on WhatsApp." } }) }],
    });
    const r = await run(fakeIo({ fetch, env }), "send", "+1415", "hi", "--account", "acc_1", "--wait", "--json");
    expect(r.code).toBe(1);
    expect(r.json.error.code).toBe("not_on_whatsapp");
  });

  it("does not retry an API refusal", async () => {
    const { fetch, calls } = mockFetch({ "POST /v1/messages": [{ status: 409, body: { code: "account_not_ready", message: "Not ready." } }] });
    const r = await run(fakeIo({ fetch, env }), "send", "+1415", "hi", "--account", "acc_1", "--json");
    expect(r.json.error).toMatchObject({ code: "account_not_ready", status: 409 });
    expect(calls).toHaveLength(1);
  });
});
