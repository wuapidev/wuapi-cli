// `wuapi run -- <command> [args...]`: runs a command with the login's API key
// in its environment (WUAPI_API_KEY, plus WUAPI_PROJECT and WUAPI_BASE_URL
// when they apply), the way `op run` or `doppler run` do. The key reaches only
// the child process: it is never printed and never written to a file, so the
// person's app, dev server or tests get it without a .env in the project.

import { DEFAULT_BASE_URL } from "@wuapidev/sdk";
import { GLOBAL_FLAGS } from "./args.js";
import { resolveAuth, type Ctx } from "./context.js";
import { usage } from "./errors.js";

export async function runCommand(ctx: Ctx): Promise<number> {
  for (const name of ctx.args.flags.keys()) {
    if (!GLOBAL_FLAGS.includes(name) || name === "json") {
      throw usage(`Unknown flag --${name} for wuapi run. Put the command after --: wuapi run -- <command> [args...]`);
    }
  }
  const [command, ...args] = ctx.args.positionals.slice(1);
  if (!command) throw usage("Usage: wuapi run [--profile <name>] -- <command> [args...]");
  const auth = resolveAuth(ctx);
  const env: Record<string, string | undefined> = { ...ctx.io.env, WUAPI_API_KEY: auth.apiKey };
  if (auth.project) env.WUAPI_PROJECT = auth.project;
  else delete env.WUAPI_PROJECT;
  if (auth.baseUrl !== DEFAULT_BASE_URL) env.WUAPI_BASE_URL = auth.baseUrl;
  return ctx.io.exec(command, args, env);
}
