import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../src/io.js";
import { main } from "../src/main.js";

export const KEY = "wu_live_abcdefghijklmnop1234";
export const KEY2 = "wu_live_qrstuvwxyzabcdef5678";

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Error;
type Route = Reply[] | ((call: Call, n: number) => Reply);

/**
 * A fetch that answers by "METHOD /path" (no query). A list of replies is
 * consumed in order and its last one repeats; an Error is thrown as a
 * network failure.
 */
export function mockFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch: typeof globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method: init.method ?? "GET", url: input, path: url.pathname, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: "not_found", message: `no route ${key}` }), { status: 404 });
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    const reply = typeof route === "function" ? route(call, n) : route[Math.min(n, route.length - 1)]!;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export interface FakeIo extends Io {
  stdout: string[];
  stderr: string[];
  sleeps: number[];
  opened: string[];
  runs: { command: string; args: string[] }[];
  clock: { t: number };
}

export function tempDir(prefix = "wuapi-cli-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function fakeIo(overrides: Partial<Io> & { configHome?: string } = {}): FakeIo {
  const configHome = overrides.configHome ?? tempDir();
  const clock = { t: Date.parse("2026-09-29T12:00:00Z") };
  const io: FakeIo = {
    env: { XDG_CONFIG_HOME: configHome, PATH: "" },
    cwd: tempDir(),
    home: tempDir(),
    platform: "linux",
    hostname: "test-host",
    stdout: [],
    stderr: [],
    sleeps: [],
    opened: [],
    runs: [],
    clock,
    out(t) {
      io.stdout.push(t);
    },
    err(t) {
      io.stderr.push(t);
    },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    fetch: (async () => {
      throw new Error("no fetch in this test");
    }) as typeof fetch,
    async sleep(ms) {
      io.sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    open(target) {
      io.opened.push(target);
    },
    which: () => false,
    run(command, args) {
      io.runs.push({ command, args });
      return { status: 0, stdout: "", stderr: "" };
    },
    readStdin: async () => "",
    pick: async () => null,
    ...overrides,
  };
  if (overrides.env) io.env = { XDG_CONFIG_HOME: configHome, PATH: "", ...overrides.env };
  return io;
}

export async function run(io: FakeIo, ...argv: string[]) {
  io.stdout.length = 0;
  io.stderr.length = 0;
  const code = await main(argv, io);
  const out = io.stdout.join("");
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    json = undefined;
  }
  return { code, out, err: io.stderr.join(""), json };
}
