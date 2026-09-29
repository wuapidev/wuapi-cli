// Every API operation as `wuapi <resource> <method> [ids...] [--field value]`.
// The table (src/generated/operations.ts) comes from the OpenAPI spec and the
// SDK's naming; the call goes through the SDK method of the same name:
//
//   client[resource...][method](...pathIds, params?)
//
// Generated SDK methods take the path parameters first, in path order, then
// one params object when the operation has query parameters or a body (never
// both), then call options.

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Paginator, type Wuapi } from "@wuapidev/sdk";
import { GLOBAL_FLAGS, type Parsed } from "./args.js";
import { emit, makeClient, type Ctx } from "./context.js";
import { CliError, usage } from "./errors.js";
import { OPERATIONS } from "./generated/operations.js";
import type { Operation } from "./operation.js";

/** `webhook-endpoints`, `webhookEndpoints`, `webhook_endpoints` -> `webhookendpoints`. */
export const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
/** `createPairingCode` -> `create-pairing-code`. */
export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export const resourceName = (op: Operation) => op.resource.map(kebab).join(" ");
export const commandName = (op: Operation) => [...op.resource.map(kebab), kebab(op.method)].join(" ");

export function usageLine(op: Operation): string {
  const ids = op.pathParams.map((p) => `<${p}>`).join(" ");
  const tail = op.hasBody ? " [--field value ...] [--data '<json>'|@file.json]" : op.query.length ? " [--param value ...]" : "";
  const all = op.paginated ? " [--all]" : "";
  return `wuapi ${commandName(op)}${ids ? ` ${ids}` : ""}${tail}${all}`;
}

/** Resource paths, e.g. `accounts`, `projects.apiKeys`. */
export function resources(): string[] {
  return [...new Set(OPERATIONS.filter((o) => o.resource.length).map((o) => o.resource.join(".")))];
}

/**
 * Finds the operation named by the leading positionals. Returns how many
 * positionals it used, or the resource when only that matched.
 */
export function findOperation(positionals: string[]): { op?: Operation; used: number; resource?: string[] } {
  const tokens = positionals.flatMap((p, i) => (i === 0 ? p.split(".") : [p]));
  const extraFromDots = tokens.length - positionals.length;
  if (tokens.length && norm(tokens[0]!) === "me") {
    const me = OPERATIONS.find((o) => o.resource.length === 0 && o.method === "me");
    return { op: me!, used: 1 };
  }
  const known = resources().map((r) => r.split("."));
  // Longest resource first: `projects api-keys list` before `projects ...`.
  const sorted = [...known].sort((a, b) => b.length - a.length);
  for (const res of sorted) {
    if (tokens.length < res.length) continue;
    if (!res.every((seg, i) => norm(seg) === norm(tokens[i]!))) continue;
    const method = tokens[res.length];
    if (method === undefined) return { used: res.length - extraFromDots, resource: res };
    const op = OPERATIONS.find((o) => o.resource.join(".") === res.join(".") && norm(o.method) === norm(method));
    if (op) return { op, used: res.length + 1 - extraFromDots };
    return { used: res.length - extraFromDots, resource: res };
  }
  return { used: 0 };
}

function fieldType(op: Operation, name: string): string | undefined {
  const q = op.query.find((f) => f.name === name);
  if (q) return q.type;
  const types = new Set(op.body.flatMap((v) => v.fields.filter((f) => f.name === name).map((f) => f.type)));
  return types.size === 1 ? [...types][0] : undefined;
}

/**
 * A flag value: JSON when it parses (numbers, booleans, arrays, objects),
 * else the string, except where the spec says the field is a string (so
 * `--chatId 5841...` stays a string) or a list of strings (`a,b` splits).
 */
export function coerce(raw: string | true, type?: string): unknown {
  if (raw === true) return true;
  const stringy = type !== undefined && (type === "string" || /^"[^"]*"( \| "[^"]*")*$/.test(type));
  if (stringy) return raw;
  let parsed: unknown;
  let ok = false;
  try {
    parsed = JSON.parse(raw);
    ok = true;
  } catch {
    ok = false;
  }
  if (type === "string[]") {
    if (ok && Array.isArray(parsed)) return parsed;
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return ok ? parsed : raw;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObject(out[k]) && isObject(v) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = target;
  for (const seg of path.slice(0, -1)) {
    if (["__proto__", "constructor", "prototype"].includes(seg)) throw usage(`Bad flag name: ${path.join(".")}`);
    if (!isObject(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (["__proto__", "constructor", "prototype"].includes(last)) throw usage(`Bad flag name: ${path.join(".")}`);
  cur[last] = value;
}

async function readData(ctx: Ctx, raw: string | true): Promise<Record<string, unknown>> {
  if (raw === true) throw usage("--data needs a JSON object, @file.json or @- (stdin).");
  let text = raw;
  if (raw === "@-") text = await ctx.io.readStdin();
  else if (raw.startsWith("@")) {
    const file = raw.slice(1);
    try {
      text = readFileSync(isAbsolute(file) ? file : join(ctx.io.cwd, file), "utf8");
    } catch (e) {
      throw usage(`Cannot read ${file}: ${(e as Error).message}`);
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw usage("--data is not valid JSON.");
  }
  if (!isObject(value)) throw usage("--data must be a JSON object.");
  return value;
}

const OWN_FLAGS = new Set([...GLOBAL_FLAGS, "data", "all"]);

/** API field names of an operation. */
function fieldNames(op: Operation): Set<string> {
  return new Set([...op.query.map((f) => f.name), ...op.body.flatMap((v) => v.fields.map((f) => f.name))]);
}

/**
 * Global flags an operation also has as a field (privacy settings have a
 * `profile` field): there the flag is the field, and the global setting comes
 * from its environment variable (WUAPI_PROFILE) instead.
 */
function shadowed(op: Operation): Set<string> {
  const names = fieldNames(op);
  return new Set(GLOBAL_FLAGS.filter((f) => names.has(f)));
}

/** The SDK call for an operation: path ids in order and the params object. */
export async function buildCall(ctx: Ctx, op: Operation, rest: string[], args: Parsed = ctx.args): Promise<{ ids: string[]; params?: Record<string, unknown> }> {
  const byFlag = new Map<string, string>();
  for (const p of op.pathParams) {
    const v = args.flags.get(p);
    if (typeof v === "string") byFlag.set(p, v);
  }
  const queue = [...rest];
  const ids = op.pathParams.map((p) => byFlag.get(p) ?? queue.shift());
  if (ids.some((v) => v === undefined)) throw usage(`Missing ${op.pathParams.filter((_, i) => ids[i] === undefined).map((p) => `<${p}>`).join(" ")}.\nUsage: ${usageLine(op)}`);
  if (queue.length) throw usage(`Unexpected argument ${JSON.stringify(queue[0])}.\nUsage: ${usageLine(op)}`);

  let params: Record<string, unknown> = {};
  const data = args.flags.get("data");
  if (data !== undefined) params = await readData(ctx, data);
  const fromFlags: Record<string, unknown> = {};
  let any = data !== undefined;
  const asField = shadowed(op);
  for (const [name, raw] of args.flags) {
    if ((OWN_FLAGS.has(name) && !asField.has(name)) || byFlag.has(name)) continue;
    any = true;
    const path = name.split(".");
    setPath(fromFlags, path, coerce(raw, path.length === 1 ? fieldType(op, name) : undefined));
  }
  params = deepMerge(params, fromFlags);
  const takesParams = op.hasBody || op.query.length > 0;
  if (!takesParams) {
    if (any) throw usage(`wuapi ${commandName(op)} takes no fields.\nUsage: ${usageLine(op)}`);
    return { ids: ids as string[] };
  }
  return { ids: ids as string[], params };
}

/** The SDK method for an operation on a client. */
export function sdkMethod(client: Wuapi, op: Operation): (...args: unknown[]) => unknown {
  let target: unknown = client;
  for (const seg of op.resource) target = (target as Record<string, unknown>)[seg];
  const fn = (target as Record<string, unknown>)?.[op.method];
  if (typeof fn !== "function") throw new CliError("internal_error", `The SDK has no ${[...op.resource, op.method].join(".")}.`);
  return (fn as (...a: unknown[]) => unknown).bind(target);
}

export async function dispatch(ctx: Ctx, op: Operation, rest: string[]): Promise<void> {
  const { ids, params } = await buildCall(ctx, op, rest);
  const hidden = shadowed(op);
  const authCtx = hidden.size ? { ...ctx, args: { ...ctx.args, flags: new Map([...ctx.args.flags].filter(([k]) => !hidden.has(k))) } } : ctx;
  const call = sdkMethod(makeClient(authCtx), op);
  const result = call(...ids, ...(params !== undefined ? [params] : []));
  if (result instanceof Paginator) {
    if (ctx.args.flags.get("all") !== undefined) {
      const items: unknown[] = [];
      for await (const item of result) items.push(item);
      emit(ctx, { object: "list", items, nextCursor: null }, () => JSON.stringify(items, null, 2));
      return;
    }
    const page = await result.page();
    emit(ctx, page, () => `${JSON.stringify(page.items, null, 2)}${page.nextCursor ? `\n\nMore: add --cursor ${page.nextCursor}, or --all for everything.` : ""}`);
    return;
  }
  const value = await result;
  emit(ctx, value === undefined ? { ok: true } : value, () => (value === undefined ? "Done." : JSON.stringify(value, null, 2)));
}
