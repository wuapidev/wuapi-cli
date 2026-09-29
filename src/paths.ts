// Where the CLI keeps its files. packages/wuapi-mcp has a copy of
// `configDir` and `credentialsPath` (src/login.ts there): keep both the same.

import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";

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

/** A device code waiting for `wuapi login --finish`. */
export function pendingLoginPath(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const dir = configDir(env, platform, home);
  return platform === "win32" ? win32.join(dir, "login-pending.json") : join(dir, "login-pending.json");
}
