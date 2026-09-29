// Everything the commands touch outside their own code, in one object, so
// tests run them with a fake network, clock, terminal and file locations.

import { spawn, spawnSync } from "node:child_process";
import { hostname, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Io {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  hostname: string;
  /** Machine-readable output (results, JSON). */
  out(text: string): void;
  /** Logs, progress, prompts. */
  err(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Opens a URL or file in the browser / default app. Best effort, never throws. */
  open(target: string): void;
  /** Whether a command is on PATH. */
  which(command: string): boolean;
  run(command: string, args: string[]): RunResult;
  /**
   * Runs a command with this environment and the terminal's stdin/stdout/stderr;
   * resolves to its exit code (127 when it cannot start).
   */
  exec(command: string, args: string[], env: Record<string, string | undefined>): Promise<number>;
  readStdin(): Promise<string>;
  /** Interactive list picker (TTY only). Resolves to an index, or null when cancelled. */
  pick(title: string, items: string[], initial: number): Promise<number | null>;
}

export function openTarget(target: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === "darwin" ? ["open", [target]] : platform === "win32" ? ["cmd", ["/c", "start", '""', target.replace(/&/g, "^&")]] : ["xdg-open", [target]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No opener on this machine: the URL is printed anyway.
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

export function execInherit(command: string, args: string[], env: Record<string, string | undefined>): Promise<number> {
  return new Promise((resolve) => {
    // Ctrl-C reaches the child too (same process group): let it decide, and
    // exit with its code.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    process.on("SIGTERM", ignore);
    const done = (code: number) => {
      process.off("SIGINT", ignore);
      process.off("SIGTERM", ignore);
      resolve(code);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: "inherit", env: env as NodeJS.ProcessEnv, shell: process.platform === "win32" });
    } catch (e) {
      process.stderr.write(`wuapi: cannot run ${command}: ${(e as Error).message}\n`);
      return done(127);
    }
    child.on("error", (e) => {
      process.stderr.write(`wuapi: cannot run ${command}: ${e.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (SIGNALS[signal] ?? 1) : 1)));
  });
}

export function onPath(command: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, command + ext))) return true;
  }
  return false;
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Arrow keys or a number, Enter to choose, Esc / q / Ctrl-C to cancel. */
export async function pickInTerminal(title: string, items: string[], initial: number): Promise<number | null> {
  const input = process.stdin;
  const output = process.stderr;
  let index = Math.max(0, Math.min(initial, items.length - 1));
  const draw = (first: boolean) => {
    if (!first) output.write(`\x1b[${items.length}A`);
    items.forEach((item, i) => output.write(`\x1b[2K${i === index ? "> " : "  "}${i + 1}. ${item}\n`));
  };
  output.write(`${title}\n`);
  draw(true);
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    const done = (value: number | null) => {
      input.off("data", onData);
      input.setRawMode?.(wasRaw ?? false);
      input.pause();
      resolve(value);
    };
    const onData = (buf: Buffer) => {
      const key = buf.toString("utf8");
      if (key === "\x1b[A" || key === "k") index = (index + items.length - 1) % items.length;
      else if (key === "\x1b[B" || key === "j") index = (index + 1) % items.length;
      else if (key === "\r" || key === "\n") return done(index);
      else if (key === "\x03" || key === "\x1b" || key === "q") return done(null);
      else if (/^[1-9]$/.test(key) && Number(key) <= items.length) {
        index = Number(key) - 1;
        draw(false);
        return done(index);
      } else return;
      draw(false);
    };
    input.on("data", onData);
  });
}

export function nodeIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    hostname: hostname(),
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    open: (target) => openTarget(target),
    which: (c) => onPath(c),
    run: (command, args) => {
      const r = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? r.error.message : "") };
    },
    exec: execInherit,
    readStdin: readAll,
    pick: pickInTerminal,
  };
}
