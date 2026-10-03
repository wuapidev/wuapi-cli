// Routes a command line to its command. Returns the exit code; never exits.

import { parseArgs } from "./args.js";
import { makeCtx, type Ctx } from "./context.js";
import { dispatch, findOperation } from "./dispatch.js";
import { toErrorBody, usage } from "./errors.js";
import { events } from "./events.js";
import { help } from "./help.js";
import type { Io } from "./io.js";
import { link, wait } from "./link.js";
import { login } from "./login.js";
import { mcp } from "./mcp.js";
import { listProfiles, logout, switchProfile, whoami } from "./profiles.js";
import { runCommand } from "./run.js";
import { send } from "./send.js";
import { VERSION } from "./version.js";

/** A command returns nothing (exit 0) or its exit code. */
const COMMANDS: Record<string, (ctx: Ctx) => void | number | Promise<void | number>> = {
  login,
  logout,
  whoami,
  profiles: listProfiles,
  switch: switchProfile,
  link,
  wait,
  send,
  events,
  mcp,
  run: runCommand,
};

async function route(ctx: Ctx): Promise<void | number> {
  const { positionals, flags } = ctx.args;
  if (flags.has("version") && positionals.length === 0) {
    ctx.io.out(ctx.json ? `${JSON.stringify({ version: VERSION })}\n` : `${VERSION}\n`);
    return;
  }
  const [first, ...rest] = positionals;
  if (first === undefined) return help(ctx, [], findOperation);
  if (first === "help") return help(ctx, rest, findOperation);

  // `wuapi profile list` is `wuapi profiles`.
  if (first === "profile") {
    if (rest[0] === "list" || rest.length === 0) return listProfiles({ ...ctx, args: { ...ctx.args, positionals: ["profiles"] } });
    if (rest[0] === "switch" || rest[0] === "use") return switchProfile({ ...ctx, args: { ...ctx.args, positionals: ["switch", ...rest.slice(1)] } });
    throw usage("Usage: wuapi profile list | wuapi switch <profile>");
  }

  const command = COMMANDS[first];
  if (command) {
    if (flags.has("help")) return help(ctx, [first], findOperation);
    return command(ctx);
  }

  const found = findOperation(positionals);
  if (found.op) {
    if (flags.has("help")) return help(ctx, positionals.slice(0, found.used), findOperation);
    return dispatch(ctx, found.op, positionals.slice(found.used));
  }
  if (found.resource) {
    if (flags.has("help") || positionals.length === found.used) return help(ctx, positionals.slice(0, found.used), findOperation);
    throw usage(`Unknown method "${positionals[found.used]}". Run \`wuapi help ${positionals.slice(0, found.used).join(" ")}\`.`);
  }
  throw usage(`Unknown command "${first}". Run \`wuapi help\`.`);
}

export async function main(argv: string[], io: Io): Promise<number> {
  let ctx: Ctx;
  try {
    ctx = makeCtx(io, parseArgs(argv));
  } catch (e) {
    const { body, exitCode } = toErrorBody(e);
    if (argv.includes("--json")) io.out(`${JSON.stringify({ error: body })}\n`);
    else io.err(`wuapi: ${body.message}\n`);
    return exitCode;
  }
  try {
    return (await route(ctx)) ?? 0;
  } catch (e) {
    const { body, exitCode } = toErrorBody(e);
    if (ctx.json) io.out(`${JSON.stringify({ error: body }, null, 2)}\n`);
    else io.err(`wuapi: ${body.message}${body.code !== "usage" ? ` (${body.code})` : ""}\n`);
    return exitCode;
  }
}
