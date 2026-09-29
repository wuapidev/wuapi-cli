import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeIo, run } from "./helpers.js";

describe("wuapi mcp add", () => {
  it("runs `claude mcp add` without any key when claude is on PATH", async () => {
    const io = fakeIo({ which: (c) => c === "claude" });
    const r = await run(io, "mcp", "add", "--scope", "user", "--json");
    expect(r.code).toBe(0);
    expect(io.runs).toEqual([{ command: "claude", args: ["mcp", "add", "wuapi", "--scope", "user", "--", "npx", "-y", "@wuapidev/mcp"] }]);
    expect(r.json).toMatchObject({ client: "claude", configured: true });
    expect(JSON.stringify(io.runs)).not.toMatch(/wu_live|WUAPI_API_KEY/);
  });

  it("prints the command when claude is not installed", async () => {
    const io = fakeIo({ env: { CLAUDECODE: "1" } });
    const r = await run(io, "mcp", "add");
    expect(io.runs).toEqual([]);
    expect(r.out).toContain("claude mcp add wuapi --scope project -- npx -y @wuapidev/mcp");
  });

  it("merges .cursor/mcp.json and .vscode/mcp.json, keeping other servers", async () => {
    const io = fakeIo();
    mkdirSync(join(io.cwd, ".cursor"));
    writeFileSync(join(io.cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect((await run(io, "mcp", "add", "--client", "cursor", "--json")).json.status).toBe("added");
    expect(JSON.parse(readFileSync(join(io.cwd, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: { other: { command: "x" }, wuapi: { command: "npx", args: ["-y", "@wuapidev/mcp"] } },
    });
    expect((await run(io, "mcp", "add", "--client", "cursor", "--json")).json.status).toBe("unchanged");
    await run(io, "mcp", "add", "--client", "vscode");
    expect(JSON.parse(readFileSync(join(io.cwd, ".vscode", "mcp.json"), "utf8"))).toEqual({
      servers: { wuapi: { type: "stdio", command: "npx", args: ["-y", "@wuapidev/mcp"] } },
    });
    writeFileSync(join(io.cwd, ".vscode", "mcp.json"), "{ // comment\n}");
    expect((await run(io, "mcp", "add", "--client", "vscode", "--json")).json.error.code).toBe("invalid_config");
  });

  it("prints instructions for every client when none is detected", async () => {
    const r = await run(fakeIo(), "mcp", "add");
    expect(r.out).toContain("Cursor");
    expect(r.out).toContain("VS Code");
    expect(r.err).toContain("wuapi login");
  });
});
