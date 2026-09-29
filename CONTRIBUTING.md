# Contributing

Thanks for taking the time to help with the wuapi CLI.

## This repository is a mirror

The CLI is developed in the wuapi monorepo, next to the API and the
TypeScript SDK it uses, and every change is copied here automatically. Nobody
commits to this repository directly: the next sync would refuse to run.

## Issues

Issues are welcome: a command that is missing or confusing, a login or link
that does not finish, output an agent cannot parse. The package version, your
Node version and OS, and the command that went wrong (with `--json` output if
you have it) help a lot. Never paste your API key or credentials file.

## Pull requests

You can open a pull request here too. We don't merge it in this repository:
a maintainer ports the change to the monorepo, credits you as co-author, and
it comes back here with the next sync. Your pull request is closed with a
link to the commit that shipped it.

Before you open one:

```sh
npm install
npm run typecheck
npm test
npm run build
```

`src/generated/operations.ts` (the table behind `wuapi <resource> <method>`)
is generated in the monorepo from the API spec with `npm run gen`; don't edit
it by hand.

## Security

Please don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
