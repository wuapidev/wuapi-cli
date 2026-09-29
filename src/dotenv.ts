// ./.env: read WUAPI_API_KEY from it, and write it there for `login --env`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_LINE = /^\s*(?:export\s+)?WUAPI_API_KEY\s*=\s*(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  const q = /^(["'])(.*)\1$/.exec(v);
  if (q) return q[2]!;
  return v.replace(/\s+#.*$/, "");
}

/** WUAPI_API_KEY from `<dir>/.env`, when the file sets it. */
export function readDotenvKey(dir: string): string | undefined {
  const path = join(dir, ".env");
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = KEY_LINE.exec(line);
    if (m) return unquote(m[1]!) || undefined;
  }
  return undefined;
}

/** Sets WUAPI_API_KEY in `<dir>/.env` (one line, created when missing). Returns the path. */
export function writeDotenvKey(dir: string, apiKey: string): string {
  const path = join(dir, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const line = `WUAPI_API_KEY=${apiKey}`;
  if (existing === null) {
    writeFileSync(path, `${line}\n`, { mode: 0o600 });
    return path;
  }
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  let placed = false;
  const out: string[] = [];
  for (const l of lines) {
    if (KEY_LINE.test(l)) {
      if (!placed) out.push(line);
      placed = true;
      continue;
    }
    out.push(l);
  }
  if (!placed) out.push(line);
  writeFileSync(path, `${out.join(eol)}${eol}`);
  return path;
}

const IGNORES_ENV = new Set([".env", "/.env", ".env*", "/.env*", "*.env"]);

/** Makes sure `<dir>/.gitignore` ignores `.env`. Returns true when it added the line. */
export function ensureGitignored(dir: string): boolean {
  const path = join(dir, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, ".env\n");
    return true;
  }
  const text = readFileSync(path, "utf8");
  if (text.split(/\r?\n/).some((l) => IGNORES_ENV.has(l.trim()))) return false;
  writeFileSync(path, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}.env\n`);
  return true;
}
