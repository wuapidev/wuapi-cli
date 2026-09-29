// `wuapi mcp add`: registers the local MCP server (`npx -y @wuapidev/mcp`)
// with an MCP client. The config holds no key: the server reads the login
// `wuapi login` stored (or WUAPI_API_KEY when the client sets one).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allowOnly, stringFlag } from "./args.js";
import { emit, log, readCreds, type Ctx } from "./context.js";
import { CliError, usage } from "./errors.js";

const COMMAND = "npx";
const ARGS = ["-y", "@wuapidev/mcp"];
const CLIENTS = ["claude", "cursor", "vscode"] as const;
type Client = (typeof CLIENTS)[number];

function claudeArgs(scope: string): string[] {
  return ["mcp", "add", "wuapi", "--scope", scope, "--", COMMAND, ...ARGS];
}

function mergeJson(path: string, key: "mcpServers" | "servers", entry: Record<string, unknown>): "added" | "updated" | "unchanged" {
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    try {
      config = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new CliError("invalid_config", `${path} is not plain JSON (comments?). Add this under "${key}" by hand: "wuapi": ${JSON.stringify(entry)}`);
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) throw new CliError("invalid_config", `${path} is not a JSON object.`);
  }
  const servers = (config[key] ?? {}) as Record<string, unknown>;
  const before = servers.wuapi;
  if (JSON.stringify(before) === JSON.stringify(entry)) return "unchanged";
  config[key] = { ...servers, wuapi: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return before === undefined ? "added" : "updated";
}

function instructions(): string {
  return [
    "Add the wuapi MCP server to your client (no key in the config: it uses your `wuapi login`):",
    "",
    "  Claude Code:  claude mcp add wuapi --scope user -- npx -y @wuapidev/mcp",
    "                (or: wuapi mcp add --client claude)",
    '  Cursor:       .cursor/mcp.json   {"mcpServers": {"wuapi": {"command": "npx", "args": ["-y", "@wuapidev/mcp"]}}}',
    "                (or: wuapi mcp add --client cursor)",
    '  VS Code:      .vscode/mcp.json   {"servers": {"wuapi": {"type": "stdio", "command": "npx", "args": ["-y", "@wuapidev/mcp"]}}}',
    "                (or: wuapi mcp add --client vscode)",
    "",
    "Any other client: run `npx -y @wuapidev/mcp` as a stdio server. Docs: https://wuapi.dev/docs/mcp",
  ].join("\n");
}

export function mcp(ctx: Ctx): void {
  const sub = ctx.args.positionals[1];
  if (sub !== "add" || ctx.args.positionals.length > 2) throw usage("Usage: wuapi mcp add [--client claude|cursor|vscode] [--scope project|user]");
  allowOnly(ctx.args, ["client", "scope"]);
  const clientFlag = stringFlag(ctx.args, "client");
  if (clientFlag !== undefined && !CLIENTS.includes(clientFlag as Client)) throw usage(`--client must be one of ${CLIENTS.join(", ")}.`);
  const scope = stringFlag(ctx.args, "scope") ?? "project";
  if (scope !== "project" && scope !== "user") throw usage("--scope must be project or user.");

  const client: Client | undefined =
    (clientFlag as Client | undefined) ?? (ctx.io.env.CLAUDECODE || ctx.io.which("claude") ? "claude" : undefined);
  const loggedIn = (() => {
    try {
      return Object.keys(readCreds(ctx).profiles).length > 0;
    } catch {
      return false;
    }
  })();
  const loginHint = loggedIn ? undefined : "Not logged in yet: run `wuapi login` so the server has a key.";

  if (!client) {
    emit(ctx, { client: null, configured: false, instructions: instructions() }, () => instructions());
    if (loginHint) log(ctx, loginHint);
    return;
  }

  if (client === "claude") {
    const args = claudeArgs(scope);
    const command = `claude ${args.join(" ")}`;
    if (!ctx.io.which("claude")) {
      emit(ctx, { client, scope, configured: false, command }, () => `Run:\n\n  ${command}`);
      if (loginHint) log(ctx, loginHint);
      return;
    }
    const r = ctx.io.run("claude", args);
    if (r.status !== 0) {
      const output = `${r.stdout}${r.stderr}`.trim();
      if (/already exists/i.test(output)) {
        emit(ctx, { client, scope, configured: true, command, status: "unchanged" }, () => `wuapi is already set up in Claude Code (${scope} scope).`);
        return;
      }
      throw new CliError("mcp_add_failed", `\`${command}\` failed${output ? `: ${output}` : "."}`);
    }
    emit(ctx, { client, scope, configured: true, command, status: "added" }, () => `Added the wuapi MCP server to Claude Code (${scope} scope). Restart Claude Code to load it.`);
    if (loginHint) log(ctx, loginHint);
    return;
  }

  if (client === "vscode" && scope === "user") {
    const payload = JSON.stringify({ name: "wuapi", command: COMMAND, args: ARGS });
    const command = `code --add-mcp '${payload}'`;
    if (ctx.io.which("code")) {
      const r = ctx.io.run("code", ["--add-mcp", payload]);
      if (r.status !== 0) throw new CliError("mcp_add_failed", `\`${command}\` failed: ${`${r.stdout}${r.stderr}`.trim()}`);
      emit(ctx, { client, scope, configured: true, command, status: "added" }, () => "Added the wuapi MCP server to your VS Code user profile.");
    } else {
      emit(ctx, { client, scope, configured: false, command }, () => `Run:\n\n  ${command}`);
    }
    if (loginHint) log(ctx, loginHint);
    return;
  }

  const base = scope === "user" ? ctx.io.home : ctx.io.cwd;
  const [path, key, entry] =
    client === "cursor"
      ? ([join(base, ".cursor", "mcp.json"), "mcpServers", { command: COMMAND, args: ARGS }] as const)
      : ([join(base, ".vscode", "mcp.json"), "servers", { type: "stdio", command: COMMAND, args: ARGS }] as const);
  const status = mergeJson(path, key, { ...entry, args: [...entry.args] });
  const name = client === "cursor" ? "Cursor" : "VS Code";
  emit(ctx, { client, scope, configured: true, path, status }, () =>
    status === "unchanged" ? `wuapi is already in ${path}.` : `${status === "added" ? "Added" : "Updated"} wuapi in ${path}. Reload ${name} to load it.`,
  );
  if (loginHint) log(ctx, loginHint);
}
