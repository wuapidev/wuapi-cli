// Argument parsing. Commands take positionals and `--flag value` /
// `--flag=value` pairs; the generic `<resource> <method>` commands accept any
// flag (they become API fields), so this parser knows only which flags never
// take a value.

import { usage } from "./errors.js";

/** Flags that never take a value: `--json`, `--all`, ... */
export const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "version",
  "all",
  "wait",
  "no-wait",
  "open",
  "no-browser",
  "env",
  "start",
  "finish",
  "here",
]);

const SHORT: Record<string, string> = { h: "help", v: "version" };

export interface Parsed {
  positionals: string[];
  /** Flag name -> raw value (`true` for a flag given without one). Repeats: the last wins. */
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!name) throw usage(`Bad flag: ${a}`);
      if (eq !== -1) {
        flags.set(name, a.slice(eq + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(name)) {
        flags.set(name, true);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next) || next === "-")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (/^-[a-z]$/i.test(a) && SHORT[a.slice(1)]) {
      flags.set(SHORT[a.slice(1)]!, true);
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

/** A string flag: undefined when absent; a usage error when given without a value. */
export function stringFlag(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  if (v === undefined) return undefined;
  if (v === true) throw usage(`--${name} needs a value.`);
  return v;
}

export function boolFlag(p: Parsed, name: string): boolean {
  const v = p.flags.get(name);
  if (v === undefined) return false;
  if (v === true) return true;
  return !/^(false|0|no|off)$/i.test(v);
}

export function numberFlag(p: Parsed, name: string, fallback: number, min = 1): number {
  const v = stringFlag(p, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) throw usage(`--${name} must be a number of at least ${min}.`);
  return n;
}

/** Fails on flags a command does not take. */
export function allowOnly(p: Parsed, allowed: string[]): void {
  const ok = new Set([...allowed, ...GLOBAL_FLAGS]);
  for (const name of p.flags.keys()) if (!ok.has(name)) throw usage(`Unknown flag --${name}.`);
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS = ["json", "help", "api-key", "base-url", "project", "profile"];
