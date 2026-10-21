# Contributing to snugcode

## Workflow
- Work on a branch and open a Pull Request to `main`. CI (syntax, typecheck, unit tests on 3 OSes, e2e) must pass;
  the Deploy workflow only runs after CI passes on `main`.
- Commit messages describe the change, e.g. `fix(relay): confirm PC linking after sign-in` — not `aaa`.
  The commit history is read by people on the `main` channel and when tracking down regressions.
- Behavior changes go in `CHANGELOG.md`; new architecture/endpoints/RPCs go in `master.md`.
- All user-facing text (PWA, CLI/TUI, relay pages, landing page) and docs are in English.

## Running tests
```bash
npm ci && npm ci --prefix relay
printf 'TOKEN_SECRET=dev\n' > relay/.dev.vars   # once; without it dev sign-in fails with "TOKEN_SECRET is not set"
npm test                      # unit tests
npm run typecheck
npm run dev:relay             # in another terminal: local relay (DEV_AUTH)
npm run test:e2e:relay && npm run test:e2e && npm run test:ui   # CHROME=/path/chrome if needed
```

## Releases ("stable" channel)
Daemons on the stable channel only install tagged releases. Without a tag, every user gets every `main` commit.
```bash
npm version minor     # bump the version + commit + tag vX.Y.Z (keep it in line with the CHANGELOG)
git push --follow-tags
```
The Release workflow runs the tests, attaches `build.json` (PWA hashes, see `docs/security.md`), and publishes to
npm if the `NPM_TOKEN` secret is set.

## Security
Vulnerabilities are reported privately (see `docs/security.md`), not through public issues.
