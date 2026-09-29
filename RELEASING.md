# Releasing the `@wuapidev/cli` npm package (the CLI, command `wuapi`)

The CLI is developed in the wuapi monorepo (`packages/wuapi-cli`) and
published from its public mirror,
[wuapidev/wuapi-cli](https://github.com/wuapidev/wuapi-cli), the same way as
the TypeScript SDK (see `packages/wuapi-sdk/RELEASING.md` for the details of
the sync). Every change to what the package ships goes to npm when it reaches
`main`; you only pick the version.

```
monorepo PR (bump the version)
  -> merge into wuapidev/wuapi main
  -> sync-cli.yml pushes the folder to wuapidev/wuapi-cli main
  -> its release.yml publishes to npm with provenance, tags v<version>, creates a GitHub Release
```

## Cutting a release

1. In your monorepo pull request, bump the version in two places to the same
   value:
   - `"version"` in `packages/wuapi-cli/package.json`
   - `VERSION` in `packages/wuapi-cli/src/version.ts` (`test/version.test.ts`
     fails when the two differ)

   Pre-1.0: a fix bumps the patch, anything else the minor. A version with a
   pre-release part (`0.2.0-beta.0`) publishes under the `next` dist-tag.
2. Merge into `main`. `.github/workflows/sync-cli.yml` mirrors the folder to
   `wuapidev/wuapi-cli`, where `.github/workflows/release.yml` typechecks,
   tests and builds it, publishes it with `npm publish --provenance` if npm
   does not have that version yet, then tags `v<version>` and creates a GitHub
   Release.

The `Version bumped` check (`.github/workflows/cli-version.yml`) fails a pull
request that changes `src/**`, `package.json`, `README.md`, `LICENSE` or
`tsconfig*.json` without a new version. Tests, `scripts/`, `.github/` and
this file need no bump.

A new `@wuapidev/sdk` version reaches this package through the `^0.x` range in
`package.json` without a release here, unless the CLI needs something new from
it. A new or changed API operation does need one: `npm run gen` regenerates
`src/generated/operations.ts` from `apps/wuapi/public/openapi.json` and
`packages/sdk-codegen/wuapi.sdk.toml` (a test fails while it is stale), and
that file ships, so bump the version (and raise the SDK range when the
operation is new in the SDK).

## One-time setup

Done once, by an owner of the `wuapidev` GitHub organization and the
`wuapihq` npm account. The package is scoped (`@wuapidev/cli`): npm refused the unscoped
`wuapi` as too similar to `hapi` and `nwsapi` (September 2026). The command
it installs is still `wuapi` (`bin` in package.json).

1. **The mirror repository.** Create `wuapidev/wuapi-cli`: public, completely
   empty (no README, license or .gitignore), description "The wuapi
   command line". The first sync pushes the history. Do not add a rule that requires
   status checks on `main` (the sync pushes before CI runs); "no force pushes
   or deletion" is fine. Turn on private vulnerability reporting (Settings >
   Security) for SECURITY.md.
2. **The sync token.** A fine-grained personal access token with resource
   owner `wuapidev`, access to `wuapi-cli` only, and **Contents** and
   **Workflows** read and write. Store it as the monorepo's Actions secret
   `CLI_REPO_TOKEN`:

   ```sh
   gh secret set CLI_REPO_TOKEN -R wuapidev/wuapi   # prompts for the token
   ```

   Renew it before it expires the same way.
3. **The npm package and trusted publishing.** Signed in to npmjs.com as
   `wuapihq`, add a trusted publisher to `@wuapidev/cli` (package Settings >
   Trusted publishing, GitHub Actions):
   - Organization or user: `wuapidev`
   - Repository: `wuapi-cli`
   - Workflow filename: `release.yml`
   - Environment: leave empty

   If npm does not let you configure a package that does not exist yet,
   publish `0.1.0` once by hand from a clean checkout of the mirror
   (done 2026-09-29; keep `bin` as `dist/cli.js` without `./`: npm 12 drops
   `./dist/cli.js` at publish, which is why 0.1.0 has no command and 0.1.1
   followed)
   (`npm ci || npm install`, `npm run build`, `npm publish --access public`,
   with 2FA), then add the trusted publisher, and from then on releases go
   through `release.yml`. Afterwards set the package's publishing access to
   "Require two-factor authentication and disallow tokens".
4. **First sync.** Run **Actions > Sync CLI > Run workflow** in the
   monorepo (or merge anything under `packages/wuapi-cli`). Then check
   **Actions > Release** in `wuapi-cli`: re-run it if it ran before step 3.

No npm token exists anywhere: `release.yml` publishes with the OIDC token of
its run (`id-token: write`).
