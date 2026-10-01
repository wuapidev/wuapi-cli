import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEY, fakeIo, mockFetch, run, tempDir } from "./helpers.js";

const msg = (status: string, over: Record<string, unknown> = {}) => ({ object: "message", id: "msg_1", accountId: "acc_1", chatId: "+584121234567", status, error: null, ...over });
const env = { WUAPI_API_KEY: KEY };
const upload = { object: "upload", id: "upl_1", projectId: null, status: "ready", mimeType: "image/jpeg", filename: null, size: 10, uploadUrl: null };

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

  it("uploads a local file and sends it by its upload id, with the text as its caption", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "photo.jpg"), "jpeg bytes");
    const { fetch, calls } = mockFetch({
      "POST /v1/uploads": [new Error("socket hang up"), { status: 201, body: upload }],
      "POST /v1/messages": [{ status: 202, body: msg("queued") }],
    });
    const r = await run(fakeIo({ fetch, env, cwd: dir }), "send", "+1415", "Look", "--file", "photo.jpg", "--account", "acc_1", "--idempotency-key", "k1", "--json");
    expect(r.code).toBe(0);
    const uploads = calls.filter((c) => c.path === "/v1/uploads");
    // The dropped upload is repeated with the same key, so the API answers one upload.
    expect(uploads.length).toBeGreaterThan(1);
    expect(new Set(uploads.map((c) => c.headers["idempotency-key"]))).toEqual(new Set(["k1:upload"]));
    expect(uploads[0]!.body).toEqual({ mimeType: "image/jpeg", filename: "photo.jpg", base64: Buffer.from("jpeg bytes").toString("base64") });
    const sent = calls.find((c) => c.path === "/v1/messages")!;
    expect(sent.body).toEqual({ accountId: "acc_1", to: "+1415", type: "image", media: { uploadId: "upl_1" }, text: "Look" });
    expect(sent.headers["idempotency-key"]).toBe("k1");
  });

  it("sends a voice note and a document from a file, without a caption", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "note.ogg"), "OggS");
    writeFileSync(join(dir, "report.bin"), "data");
    const { fetch, calls } = mockFetch({
      "POST /v1/uploads": [{ status: 201, body: upload }],
      "POST /v1/messages": [{ status: 202, body: msg("queued") }],
    });
    const io = () => fakeIo({ fetch, env, cwd: dir });
    expect((await run(io(), "send", "+1415", "--file", "note.ogg", "--type", "voice", "--account", "acc_1")).code).toBe(0);
    expect(calls.at(-2)!.body).toMatchObject({ mimeType: "audio/ogg; codecs=opus" });
    expect(calls.at(-1)!.body).toEqual({ accountId: "acc_1", to: "+1415", type: "voice", media: { uploadId: "upl_1" } });

    const doc = await run(io(), "send", "+1415", "--file", join(dir, "report.bin"), "--mime-type", "application/octet-stream", "--filename", "Q3.bin", "--account", "acc_1");
    expect(doc.code).toBe(0);
    expect(calls.at(-2)!.body).toMatchObject({ mimeType: "application/octet-stream", filename: "Q3.bin" });
    expect(calls.at(-1)!.body).toEqual({ accountId: "acc_1", to: "+1415", type: "document", media: { uploadId: "upl_1", filename: "Q3.bin" } });
  });

  it("posts a large file to the upload URL, then completes and sends it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "clip.mp4"), Buffer.alloc(2 * 1024 * 1024, 1));
    const { fetch, calls } = mockFetch({
      "POST /v1/uploads": [{ status: 201, body: { ...upload, status: "pending", uploadUrl: "https://files.example.com/api/storage/upload" } }],
      "POST /api/storage/upload": [{ body: { storageId: "st_1" } }],
      "POST /v1/uploads/upl_1/complete": [{ body: upload }],
      "POST /v1/messages": [{ status: 202, body: msg("queued") }],
    });
    const r = await run(fakeIo({ fetch, env, cwd: dir }), "send", "+1415", "--file", "clip.mp4", "--account", "acc_1");
    expect(r.code).toBe(0);
    expect(calls.map((c) => c.path)).toEqual(["/v1/uploads", "/api/storage/upload", "/v1/uploads/upl_1/complete", "/v1/messages"]);
    expect(calls[0]!.body).toEqual({ mimeType: "video/mp4", filename: "clip.mp4", size: 2 * 1024 * 1024 });
    expect(calls[1]!.headers).toEqual({ "content-type": "video/mp4" });
    expect(calls[2]!.body).toEqual({ storageId: "st_1" });
    expect(calls[3]!.body).toMatchObject({ type: "video", media: { uploadId: "upl_1" } });
  });

  it("refuses a file it cannot read or type, and file flags without --file, before calling the API", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "data.xyz"), "x");
    writeFileSync(join(dir, "empty.jpg"), "");
    const { fetch, calls } = mockFetch({});
    const io = () => fakeIo({ fetch, env, cwd: dir });
    const cases: string[][] = [
      ["send", "+1415", "--file", "missing.jpg"],
      ["send", "+1415", "--file", "data.xyz"],
      ["send", "+1415", "--file", "empty.jpg"],
      ["send", "+1415", "--file", "data.xyz", "--mime-type", "image/png", "--type", "gif"],
      ["send", "+1415", "hi", "--type", "voice"],
      ["send", "+1415"],
    ];
    for (const args of cases) {
      const r = await run(io(), ...args, "--account", "acc_1", "--json");
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(calls).toHaveLength(0);
  });

  it("does not retry an API refusal", async () => {
    const { fetch, calls } = mockFetch({ "POST /v1/messages": [{ status: 409, body: { code: "account_not_ready", message: "Not ready." } }] });
    const r = await run(fakeIo({ fetch, env }), "send", "+1415", "hi", "--account", "acc_1", "--json");
    expect(r.json.error).toMatchObject({ code: "account_not_ready", status: 409 });
    expect(calls).toHaveLength(1);
  });
});
