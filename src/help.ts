// `wuapi help`, `wuapi help <resource>`, `wuapi <resource> <method> --help`.

import { emit, type Ctx } from "./context.js";
import { commandName, kebab, resources, usageLine } from "./dispatch.js";
import { usage } from "./errors.js";
import { OPERATIONS } from "./generated/operations.js";
import type { Operation, OperationField } from "./operation.js";
import { VERSION } from "./version.js";

const COMMANDS: [string, string][] = [
  ["login [--no-browser] [--profile <name>]", "Log in from the browser; stores an API key as a profile (never printed)"],
  ["login --start | --finish", "The same in two steps, for agents that cannot watch a running command"],
  ["logout [<profile>] [--all]", "Forget a stored login (the key stays valid until revoked)"],
  ["whoami", "The organization, project and key in use"],
  ["profiles", "The stored logins; * marks the current one"],
  ["switch [<profile>]", "Change the current profile"],
  ["link [--phone +E164] [--country XX] [--no-wait]", "Create a link the person opens to link their WhatsApp (QR code or pairing code there)"],
  ["link --here [--phone +E164] [--country XX]", "Link in this terminal (QR code here, or a pairing code); for a person, not agents"],
  ["wait <invitationId | accountId>", "Wait until the number is linked and ready"],
  ["run -- <command> [args...]", "Run a command with WUAPI_API_KEY in its environment only (no .env)"],
  ["send <to> <text> [--account <id>] [--wait]", "Send a text message, or a local file with --file <path>"],
  ["mcp add [--client claude|cursor|vscode] [--scope project|user]", "Set up the wuapi MCP server in your editor or agent"],
  ["me", "The current key's organization and project (API: GET /v1/me)"],
];

const GLOBALS: [string, string][] = [
  ["--json", "JSON on stdout (errors too: {\"error\":{code,message}}); logs on stderr"],
  ["--profile <name>", "Use a stored profile for this command (or WUAPI_PROFILE)"],
  ["--api-key <key>", "Use this key (or WUAPI_API_KEY, or WUAPI_API_KEY in ./.env)"],
  ["--project <id>", "Act inside one project: its id or ext:<externalId> (or WUAPI_PROJECT)"],
  ["--base-url <url>", "API base URL (or WUAPI_BASE_URL; default https://api.wuapi.dev)"],
  ["--help, --version", ""],
];

/** `wuapi <command> --help` for the hand-written commands. */
export const COMMAND_HELP: Record<string, string> = {
  login: [
    "Usage: wuapi login [--no-browser] [--profile <name>] [--env]",
    "       wuapi login --start   then   wuapi login --finish   (in the same folder)",
    "",
    "Shows a code and a URL (and opens it), waits until you approve it at wuapi.dev,",
    "then stores the new API key as a profile and makes it current. The key is kept in",
    "the CLI's own file (~/.config/wuapi/credentials.json, 0600) and never printed.",
    "Commands, the MCP server and `wuapi run -- <command>` use it from there.",
    "",
    "  --env             also write WUAPI_API_KEY to ./.env (and add .env to ./.gitignore).",
    "                    This puts the key in a project file: for people, not for agents",
    "  --no-browser      do not open the browser",
    "  --profile <name>  the profile's name (default: the organization, or organization/project)",
    "  --start           only request the code: print {url, code, expiresIn} and exit",
    "  --finish          wait for the code --start requested in this folder",
  ].join("\n"),
  logout: "Usage: wuapi logout [<profile>] [--all]\n\nForgets the current (or named) profile; --all forgets every one. The key stays valid:\nrevoke it at https://wuapi.dev/app/api-keys.",
  whoami: "Usage: wuapi whoami\n\nThe organization, project and key in use, and where the key came from.",
  profiles: "Usage: wuapi profiles   (or wuapi profile list)\n\nThe stored logins; * marks the current one.",
  switch: "Usage: wuapi switch [<profile>]\n\nMakes a profile current. Without a name, a picker (in a terminal).",
  link: [
    "Usage: wuapi link [--phone +E164] [--country XX] [--city name] [--name label] [--no-wait] [--no-browser] [--timeout 900]",
    "       wuapi link --here [--phone +E164] [--country XX] [--city name] [--name label] [--open] [--no-wait] [--timeout 300]",
    "",
    "Creates an invitation: a link (valid 1 day) the person opens to link their WhatsApp,",
    "choosing the QR code or the pairing code on that page. The link opens in the browser",
    "unless --no-browser. This command never shows a QR code or pairing code, so an agent",
    "running it never sees one. Then it waits until the number is linked and ready.",
    "",
    "  --phone +E164   the number to link: prefills the page and sets the country",
    "  --country XX    where the number's traffic exits (ISO code). Default: the phone's country;",
    "                  without either, the person picks it on the page",
    "  --city name     a city in that country (best match); default: its biggest city",
    "  --name label    your label for the account",
    "  --no-wait       print {invitationId, url, expiresAt} and exit (then: wuapi wait <invitationId>)",
    "  --no-browser    do not open the link",
    "  --timeout s     give up waiting after this many seconds (default 900)",
    "",
    "  --here          link in this terminal instead: the QR code is drawn here, or with --phone a",
    "                  pairing code to type in WhatsApp > Settings > Linked devices > Link a device >",
    "                  Link with phone number instead. For a person at the terminal; agents should",
    "                  not use it. With --here, --open also opens the QR code in the browser and",
    "                  --no-wait prints the account id and the code.",
  ].join("\n"),
  wait: [
    "Usage: wuapi wait <invitationId | accountId> [--timeout seconds]",
    "",
    "With an invitation id (from wuapi link --no-wait): waits until the person links the number",
    "on the page and the account is ready (default 900 s). Fails when the invitation fails,",
    "expires or is cancelled.",
    "With an account id: waits until the account is ready (default 300 s), showing new QR or",
    "pairing codes of an account linked with --here (--open: in the browser too).",
  ].join("\n"),
  run: [
    "Usage: wuapi run [--profile <name>] -- <command> [args...]",
    "",
    "Runs the command with WUAPI_API_KEY (and WUAPI_PROJECT when the profile has a project,",
    "WUAPI_BASE_URL when it is not the default) set in its environment only, and exits with",
    "its exit code. Your app, dev server or tests read process.env.WUAPI_API_KEY without a",
    ".env file, and the key is never printed. e.g. wuapi run -- npm run dev",
  ].join("\n"),
  send: [
    "Usage: wuapi send <to> <text> [--account <id>] [--wait] [--timeout 120] [--idempotency-key <key>]",
    "       wuapi send <to> [caption] --file <path> [--type <type>] [--mime-type <type>] [--filename <name>]",
    "",
    "Sends a text message, or a local file. <to>: E.164 number, group id (…@g.us) or channel id.",
    "  --account <id>     the account to send from (default: the only ready one)",
    "  --wait             wait until it is sent, delivered or failed",
    "  --file <path>      upload this file (up to 100 MB) and send it; the text becomes its caption",
    "  --type <type>      image, video, audio, voice, document or sticker (default: from the file's type)",
    "  --mime-type <type> the file's MIME type (default: from its extension)",
    "  --filename <name>  the name a document shows (default: the file's name)",
    "A voice note is an Ogg/Opus file: wuapi send +5841... --file note.ogg --type voice",
    "Other message types: wuapi messages send --help",
  ].join("\n"),
  mcp: [
    "Usage: wuapi mcp add [--client claude|cursor|vscode] [--scope project|user]",
    "",
    "Registers the local MCP server (npx -y @wuapidev/mcp) with your client. The config holds",
    "no key: the server uses your `wuapi login`. Default client: Claude Code when detected,",
    "else instructions for each client.",
  ].join("\n"),
};

function columns(rows: [string, string][], indent = "  "): string {
  const width = Math.min(58, Math.max(...rows.map(([a]) => a.length)));
  return rows.map(([a, b]) => (b ? `${indent}${a.padEnd(width)}  ${b}` : `${indent}${a}`)).join("\n");
}

export function mainHelp(): string {
  const res = resources();
  const counts = res.map((r) => [r.split(".").map(kebab).join(" "), OPERATIONS.filter((o) => o.resource.join(".") === r).length] as const);
  const resourceLines: string[] = [];
  let line = " ";
  for (const [name, n] of counts) {
    const item = ` ${name} (${n})`;
    if (line.length + item.length > 88) {
      resourceLines.push(line);
      line = " ";
    }
    line += item;
  }
  resourceLines.push(line);
  return [
    `wuapi ${VERSION}: the wuapi command line. Docs: https://wuapi.dev/docs#cli`,
    "",
    "Usage: wuapi <command> [flags]",
    "",
    "Commands:",
    columns(COMMANDS),
    "",
    "Every API endpoint:",
    "  wuapi <resource> <method> [ids...] [--field value ...] [--data '<json>'|@file.json] [--all]",
    "  e.g. wuapi messages list --accountId acc_1 --limit 5",
    "       wuapi groups get <accountId> <groupId>",
    "",
    "Resources:",
    ...resourceLines,
    "",
    "Global flags:",
    columns(GLOBALS),
    "",
    "`wuapi help <resource>` lists its methods; `wuapi <resource> <method> --help` shows the fields.",
  ].join("\n");
}

export function resourceHelp(resource: string[]): string {
  const key = resource.join(".");
  const ops = OPERATIONS.filter((o) => o.resource.join(".") === key || o.resource.join(".").startsWith(`${key}.`));
  const rows: [string, string][] = ops.map((o) => [usageLine(o).replace(/ \[--.*$/, ""), `${o.summary}${o.deprecated ? " (deprecated)" : ""}`]);
  return [`wuapi ${resource.map(kebab).join(" ")}`, "", columns(rows), "", `Details: wuapi ${resource.map(kebab).join(" ")} <method> --help`].join("\n");
}

function fieldRows(fields: OperationField[], flagPrefix = "--"): [string, string][] {
  const short = (d: string) => (d.length > 110 ? `${d.slice(0, 109).trimEnd()}…` : d);
  return fields.map((f) => [`${flagPrefix}${f.name} ${f.type}${f.required ? " (required)" : ""}`, short(f.description)]);
}

export function operationHelp(op: Operation): string {
  const out = [`wuapi ${commandName(op)}: ${op.summary}${op.deprecated ? " (deprecated)" : ""}`, `${op.httpMethod} ${op.path}`, ""];
  if (op.description) out.push(op.description, "");
  out.push(`Usage: ${usageLine(op)}`, "");
  if (op.pathParams.length) out.push("Arguments (or as --name value):", columns(op.pathParams.map((p) => [`<${p}>`, ""])), "");
  if (op.query.length) out.push("Query parameters:", columns(fieldRows(op.query)), "");
  if (op.hasBody) {
    if (op.body.length === 1) out.push(`Body${op.bodyRequired ? "" : " (optional)"}:`, columns(fieldRows(op.body[0]!.fields)), "");
    else {
      // Fields every shape shares once, then what each shape adds.
      const common = op.body[0]!.fields.filter((f) => f.name !== "type" && op.body.every((v) => v.fields.some((g) => g.name === f.name && g.required === f.required)));
      const shared = new Set(common.map((f) => f.name));
      out.push(`Body, one of ${op.body.length} shapes (pick one with --type):`);
      if (common.length) out.push("  every shape:", columns(fieldRows(common), "    "));
      for (const v of op.body) out.push(`  --type ${v.name}:`, columns(fieldRows(v.fields.filter((f) => !shared.has(f.name) && f.name !== "type")), "    "));
      out.push("");
    }
    out.push("Nested fields: --a.b value. Values are JSON when they parse (numbers, true, [\"x\"]), else text.", "--data '<json>' or @file.json or @- (stdin) sets the body; flags override it.", "");
  }
  if (op.paginated) out.push("Prints one page (see nextCursor); --all fetches every page.", "");
  return out.join("\n").trimEnd();
}

export function help(ctx: Ctx, topic: string[], find: (p: string[]) => { op?: Operation; used: number; resource?: string[] }): void {
  if (topic.length === 0) return emit(ctx, { help: mainHelp() }, mainHelp);
  const command = topic[0] === "profile" ? "profiles" : topic[0]!;
  if (topic.length === 1 && COMMAND_HELP[command]) return emit(ctx, { help: COMMAND_HELP[command] }, () => COMMAND_HELP[command]!);
  const found = find(topic);
  if (found.op) {
    const text = operationHelp(found.op);
    return emit(ctx, { operation: found.op, usage: usageLine(found.op), help: text }, () => text);
  }
  if (found.resource) {
    const text = resourceHelp(found.resource);
    const key = found.resource.join(".");
    return emit(ctx, { resource: key, operations: OPERATIONS.filter((o) => o.resource.join(".") === key || o.resource.join(".").startsWith(`${key}.`)).map((o) => ({ command: commandName(o), usage: usageLine(o), summary: o.summary })), help: text }, () => text);
  }
  throw usage(`Unknown command or resource: ${topic.join(" ")}. Run \`wuapi help\`.`);
}
