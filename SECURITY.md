# Security

## Reporting a vulnerability

Please report vulnerabilities privately, with GitHub's
[private vulnerability reporting](https://github.com/wuapidev/wuapi-cli/security/advisories/new)
for this repository. Don't open a public issue.

Include what you found, how to reproduce it, the package version, your OS and
Node version. We'll acknowledge the report, keep you posted while we fix
it, and credit you in the release notes unless you'd rather stay anonymous.

This covers the CLI in this repository: how it logs in, stores keys
(`~/.config/wuapi/credentials.json`, mode 0600) and writes files such as
`.env` and MCP client configs. For the wuapi API itself, use the same form; we
route it to the right place.

## Supported versions

Fixes ship in a new release of the latest minor version. We're pre-1.0, so
upgrade to the newest `0.x` to get them. `npx @wuapidev/cli` runs the latest
unless you installed a fixed version.
