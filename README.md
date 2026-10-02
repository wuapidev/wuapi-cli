# wuapi CLI

[![npm version](https://img.shields.io/npm/v/@wuapidev/cli.svg)](https://www.npmjs.com/package/@wuapidev/cli)
[![CI](https://github.com/wuapidev/wuapi-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/wuapidev/wuapi-cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@wuapidev/cli.svg)](LICENSE)

The command line for [wuapi](https://wuapi.dev), the WhatsApp API for developers. Log in from the browser, link a number through a link you open (QR code or pairing code there), run your app with the key, send a message, set up the MCP server, and call every endpoint of the API, from your terminal or from an AI agent.

```sh
npx @wuapidev/cli login                         # opens the browser, stores a key
npx @wuapidev/cli link --phone +584121234567    # opens a link to scan the QR code or type the pairing code, waits until linked
npx @wuapidev/cli send +584121234567 "Hola"     # sends from your linked number
npx @wuapidev/cli run -- npm run dev            # runs your app with WUAPI_API_KEY set, no .env
```

Node 20 or later. Using it often? Install it once and the command is just `wuapi`:

```sh
npm install -g @wuapidev/cli
wuapi login
```

Docs: [wuapi.dev/docs#cli](https://wuapi.dev/docs#cli).

> wuapi links your own numbers as devices, the same way WhatsApp Web works. It does not use the WhatsApp Business Platform. WhatsApp can restrict numbers that behave like spam: send only to people who expect your messages.

## Commands

| Command | |
|---|---|
| `wuapi login [--no-browser] [--profile <name>] [--env]` | Log in in the browser. The CLI shows a code, you approve it at wuapi.dev, and it stores a new API key in its own file (never printed). `--env` also writes `WUAPI_API_KEY` to `./.env` and adds `.env` to `./.gitignore`: that puts the key in a project file, so it is for people, not for agents (use `wuapi run` instead). |
| `wuapi login --start` / `--finish` | The same in two steps (see [Agents](#agents)). Run both in the same folder: each folder keeps its own pending login, so two sessions in different folders do not collide. |
| `wuapi profiles` | Your stored logins, `*` on the current one. |
| `wuapi switch [<profile>]` | Change the current profile (a picker when you leave out the name). |
| `wuapi logout [<profile>] [--all]` | Forget a login. The key stays valid until you revoke it at [wuapi.dev/app/api-keys](https://wuapi.dev/app/api-keys). |
| `wuapi whoami` | The organization, project and key in use. |
| `wuapi link [--phone +E164] [--country XX] [--city name] [--name label] [--no-wait] [--no-browser] [--timeout 900]` | Create an invitation: a link (valid 1 day) the person opens, in the browser, to link their WhatsApp with the QR code or the pairing code shown there. The CLI opens it (unless `--no-browser`), prints it, and waits until the number is linked and ready. It never shows a QR code or pairing code itself. The proxy location is the number's country (from `--phone`, or `--country`) and its biggest city, or the best match for `--city`; with neither, the person picks it on the page. `--no-wait` prints `{invitationId, url, expiresAt}` and exits. |
| `wuapi link --here [--phone +E164] [--country XX] [--city name] [--name label] [--open] [--no-wait] [--timeout 300]` | Link in this terminal, for a person at the terminal (agents should not use it). Without `--phone`: a QR code drawn here (`--open` also opens it in the browser; it refreshes as the code rotates). With `--phone`: an 8-character pairing code to type in WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead. |
| `wuapi wait <invitationId \| accountId> [--timeout seconds]` | Wait until the number is linked and ready: an invitation from `link --no-wait` (default 900 s; fails when it fails, expires or is cancelled) or an account (default 300 s). |
| `wuapi run [--profile <name>] -- <command> [args...]` | Run a command with `WUAPI_API_KEY` (plus `WUAPI_PROJECT` when the profile has a project, `WUAPI_BASE_URL` when it is not the default) in its environment only, and exit with its code. Your app, dev server or tests read `process.env.WUAPI_API_KEY` without a `.env`, like `op run` or `doppler run`. |
| `wuapi send <to> <text> [--account <id>] [--wait]` | Send a text. `--account` can be left out when one account is ready. `--wait` waits until it is sent or failed. |
| `wuapi send <to> [caption] --file <path> [--type <type>] [--mime-type <type>] [--filename <name>]` | Send a local file, up to 100 MB: it is uploaded, then sent by its upload id. The type (`image`, `video`, `audio`, `document`) and MIME type come from the file's extension; pass `--type voice` for an Ogg/Opus voice note, `--type sticker` for a WebP sticker, `--mime-type` for an extension the CLI does not know. |
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
wuapi messages forward msg_1 --to '["+584121234567","120363012345678901@g.us"]'
wuapi webhook-endpoints create --url https://example.com/hook --events '["message.received"]'
wuapi projects api-keys list prj_1 --all
wuapi me
```

Ids are positional, in the order the path takes them (or `--accountId acc_1`). Other flags are the query parameters or body fields of the operation: values are JSON when they parse (`5`, `true`, `["a"]`), text otherwise, and always text where the API expects a string. `--a.b value` sets a nested field. `--data` takes a JSON body, `@file.json` or `@-` (stdin); flags override it. List methods print one page (with `nextCursor`); `--all` fetches every page.

`wuapi help` lists the resources, `wuapi help <resource>` its methods, and `wuapi <resource> <method> --help` the fields, from the OpenAPI spec.

## Keys and profiles

The key comes from, in order: `--api-key`, `WUAPI_API_KEY`, `WUAPI_API_KEY` in `./.env`, the profile `--profile` or `WUAPI_PROFILE` names, the current profile. `--project <id or ext:externalId>` (or `WUAPI_PROJECT`) acts inside one project; a profile made from a project key uses its project. `--base-url` / `WUAPI_BASE_URL` point at another API host (https only, or http on localhost).

Each `wuapi login` adds a profile, named after the organization (`acme`) or organization and project (`acme/store-1`), and makes it current. Profiles live in `~/.config/wuapi/credentials.json` (`$XDG_CONFIG_HOME/wuapi`, or `%APPDATA%\wuapi` on Windows), readable only by you, outside your project. The CLI never prints a key.

Your code reads `process.env.WUAPI_API_KEY`; run it with `wuapi run -- <command>` (for example `wuapi run -- npm test`) and the key reaches only that process, with no `.env` in the project.

## Agents

Every command takes `--json`: the result is JSON on stdout, logs and progress go to stderr, and a failure exits non-zero with `{"error": {"code", "message"}}` on stdout. With `--json`, or when stdin is not a terminal, the CLI never asks anything.

An agent whose shell only shows output after a command ends logs in in two steps:

```sh
npx @wuapidev/cli login --start --json   # {"url": "...", "code": "ABCD-EFGH", "expiresIn": 600}; show both to the person
npx @wuapidev/cli login --finish --json  # same folder; waits until they approve, then {"profile", "organization", "project", ...}
```

Linking works the same way, and the agent never sees a QR code or pairing code:

```sh
npx @wuapidev/cli link --phone +584121234567 --no-wait --json   # {"invitationId", "url", "expiresAt"}; the link also opens in the browser
npx @wuapidev/cli wait <invitationId> --json                    # returns {accountId, phone, status} once the person linked it
```

The agent gives the person the `url`; they open it and link with the QR code or the pairing code on that page. If the invitation fails or expires, run `link` again.

Keep the key out of the agent's reach: an agent should never read `~/.config/wuapi`, write the key to `.env` or echo it. It uses `wuapi run -- <command>` to run the project's code. In Claude Code you can add a deny rule to `.claude/settings.json`: `"permissions": {"deny": ["Read(~/.config/wuapi/**)"]}`. An agent with shell access as your user could still read a file you can read; that rule, plus never writing the key into the project, is the practical protection.

`wuapi send` uses one idempotency key per command and reuses it on every retry, so a request cut off midway is never sent twice. Every wait is bounded (`--timeout`), and a dropped connection during a login, link or wait is retried until then.

## License

MIT
