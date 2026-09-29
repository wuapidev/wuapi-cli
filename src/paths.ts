// Where the CLI keeps its files. packages/wuapi-mcp has a copy of
// `configDir` and `credentialsPath` (src/login.ts there): keep both the same.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, win32 } from "node:path";

type Env = Record<string, string | undefined>;

/**
 * The CLI's config directory: `%APPDATA%\wuapi` on Windows,
 * `$XDG_CONFIG_HOME/wuapi` when set (an absolute path), else `~/.config/wuapi`.
 */
export function configDir(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return win32.join(appData || win32.join(home, "AppData", "Roaming"), "wuapi");
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return posix.join(xdg && isAbsolute(xdg) ? xdg : posix.join(home, ".config"), "wuapi");
}

/** The stored logins: `<configDir>/credentials.json`. */
export function credentialsPath(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const dir = configDir(env, platform, home);
  return platform === "win32" ? win32.join(dir, "credentials.json") : join(dir, "credentials.json");
}

/**
 * A device code waiting for `wuapi login --finish`, one per working directory:
 * `<configDir>/login-pending-<hash of realpath(cwd)>.json`. Two agent sessions
 * in different folders (say OpenCode and Claude Code at once) each keep their
 * own, and `--finish` in the same folder finds the one `--start` wrote.
 */
export function pendingLoginPath(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  cwd: string = process.cwd(),
): string {
  const dir = configDir(env, platform, home);
  let folder: string;
  try {
    folder = realpathSync(cwd);
  } catch {
    folder = resolve(cwd);
  }
  const file = `login-pending-${createHash("sha256").update(folder).digest("hex").slice(0, 16)}.json`;
  return platform === "win32" ? win32.join(dir, file) : join(dir, file);
}
