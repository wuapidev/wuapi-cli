# wuapi CLI

[![npm version](https://img.shields.io/npm/v/wuapi.svg)](https://www.npmjs.com/package/wuapi)
[![CI](https://github.com/wuapidev/wuapi-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/wuapidev/wuapi-cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/wuapi.svg)](LICENSE)

The command line for [wuapi](https://wuapi.dev), the WhatsApp API for developers. Log in from the browser, link a number by QR code or pairing code, send a message, set up the MCP server, and call every endpoint of the API, from your terminal or from an AI agent.

```sh
npx wuapi login                      # opens the browser, stores a key
npx wuapi link --country VE          # shows a QR code, waits until the number is linked
npx wuapi send +584121234567 "Hola"  # sends from your linked number
```

Node 20 or later. Docs: [wuapi.dev/docs#cli](https://wuapi.dev/docs#cli).

> wuapi links your own numbers as devices, the same way WhatsApp Web works. It does not use the WhatsApp Business Platform. WhatsApp can restrict numbers that behave like spam: send only to people who expect your messages.

## Commands

| Command | |
|---|---|
| `wuapi login [--env] [--no-browser] [--profile <name>]` | Log in in the browser. The CLI shows a code, you approve it at wuapi.dev, and it stores a new API key. `--env` also writes `WUAPI_API_KEY` to `./.env` and adds `.env` to `./.gitignore`. |
| `wuapi login --start` / `--finish` | The same in two steps (see [Agents](#agents)). |
| `wuapi profiles` | Your stored logins, `*` on the current one. |
| `wuapi switch [<profile>]` | Change the current profile (a picker when you leave out the name). |
| `wuapi logout [<profile>] [--all]` | Forget a login. The key stays valid until you revoke it at [wuapi.dev/app/api-keys](https://wuapi.dev/app/api-keys). |
| `wuapi whoami` | The organization, project and key in use. |
| `wuapi link [--phone +E164] [--country XX] [--city name] [--name label] [--open] [--no-wait] [--timeout 300]` | Create an account and link it. Without `--phone`: a QR code in the terminal (`--open` also opens it in the browser; it refreshes as the code rotates). With `--phone`: an 8-character pairing code to type in WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead. The proxy location is the number's country (from `--phone`, or `--country`) and its biggest city, or the best match for `--city`. |
| `wuapi wait <accountId> [--timeout 300]` | Wait until an account is linked and ready. |
| `wuapi send <to> <text> [--account <id>] [--wait]` | Send a text. `--account` can be left out when one account is ready. `--wait` waits until it is sent or failed. |
| `wuapi mcp add [--client claude\|cursor\|vscode] [--scope project\|user]` | Register the local MCP server (`npx -y @wuapidev/mcp`) with your client. No key goes into the client's config: the server uses your `wuapi login`. |

### Every API endpoint

```sh
wuapi <resource> <method> [ids...] [--field value ...] [--data '<json>'|@file.json] [--all]
```

```sh
wuapi accounts list
wuapi messages list --accountId acc_1 --limit 5
wuapi groups get acc_1 120363012345678901@g.us
wuapi messages send --accountId acc_1 --to +584121234567 --type image --media.url https://example.com/a.jpg
wuapi webhook-endpoints create --url https://example.com/hook --events '["message.received"]'
wuapi projects api-keys list prj_1 --all
wuapi me
```

Ids are positional, in the order the path takes them (or `--accountId acc_1`). Other flags are the query parameters or body fields of the operation: values are JSON when they parse (`5`, `true`, `["a"]`), text otherwise, and always text where the API expects a string. `--a.b value` sets a nested field. `--data` takes a JSON body, `@file.json` or `@-` (stdin); flags override it. List methods print one page (with `nextCursor`); `--all` fetches every page.

`wuapi help` lists the resources, `wuapi help <resource>` its methods, and `wuapi <resource> <method> --help` the fields, from the OpenAPI spec.

## Keys and profiles

The key comes from, in order: `--api-key`, `WUAPI_API_KEY`, `WUAPI_API_KEY` in `./.env`, the profile `--profile` or `WUAPI_PROFILE` names, the current profile. `--project <id or ext:externalId>` (or `WUAPI_PROJECT`) acts inside one project; a profile made from a project key uses its project. `--base-url` / `WUAPI_BASE_URL` point at another API host (https only, or http on localhost).

Each `wuapi login` adds a profile, named after the organization (`acme`) or organization and project (`acme/store-1`), and makes it current. Profiles live in `~/.config/wuapi/credentials.json` (`$XDG_CONFIG_HOME/wuapi`, or `%APPDATA%\wuapi` on Windows), readable only by you. The CLI never prints a key.

## Agents

Every command takes `--json`: the result is JSON on stdout, logs and progress go to stderr, and a failure exits non-zero with `{"error": {"code", "message"}}` on stdout. With `--json`, or when stdin is not a terminal, the CLI never asks anything.

An agent whose shell only shows output after a command ends logs in in two steps:

```sh
npx wuapi login --start --json   # {"url": "...", "code": "ABCD-EFGH", "expiresIn": 600}; show both to the person
npx wuapi login --finish --json  # waits until they approve, then {"profile", "organization", "project", ...}
```

Linking works the same way: `wuapi link --phone +584121234567 --no-wait --json` returns the account id and the pairing code at once (without `--phone`, `qrCodeUrl` and `qrCodeFile`, a PNG to show), and `wuapi wait <accountId> --json` returns when the number is ready.

`wuapi send` uses one idempotency key per command and reuses it on every retry, so a request cut off midway is never sent twice. Every wait is bounded (`--timeout`), and a dropped connection during a login, link or wait is retried until then.

## License

MIT
