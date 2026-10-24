# Contributing to snugcode

Thanks for helping out! This repo holds everything that runs on users' devices: the daemon & TUI (`daemon/`), the
phone app (`web/`), encryption & protocol (`shared/`), and the cloud runner image (`.devcontainer/`, `Dockerfile`).
The hosted relay & website at snugcode.dev are maintained separately. For development and tests, use the local dev
relay included here.

## Set up

```bash
npm ci
npm run build:web             # PWA → dist/web
npm run dev:relay             # local relay at http://127.0.0.1:8787 (app at /agent/, dev sign-in by username)
```

In another terminal, run a daemon against it:

```bash
SNUGCODE_HOME=/tmp/snug node daemon/cli.js setup --relay http://127.0.0.1:8787 \
  --key <API key> --skip-github --pin 123456 --name DevPC     # router key: add --url <URL>
SNUGCODE_HOME=/tmp/snug node daemon/cli.js start
```

Then open http://127.0.0.1:8787/agent/ and sign in with any username.

## Tests

```bash
npm test                      # unit tests
npm run typecheck             # tsc --checkJs: daemon, shared, PWA
# with `npm run dev:relay` running:
npm run test:e2e              # phone → relay → daemon → Agent SDK → mock model (no real keys)
npm run test:e2e:cloud        # cloud runner: provision → `snugcode cloud` → automatic pairing
npm run test:ui               # built PWA in Chrome + TUI in a pseudo-terminal (CHROME=/path/chrome if needed)
npm run test:e2e:resume       # PWA reconnecting after a stalled network
npm run test:e2e:connections  # new model connections (SNUGCODE_E2E_CODEX=<codex folder>)
npm run test:e2e:gemini       # Gemini CLI engine (SNUGCODE_E2E_GEMINI=<bundle/gemini.js> or =install)
node test/worktree.it.mjs     # branch/worktree scenarios (needs internet)
npm run docs:images           # regenerate README images & GIFs
```

The e2e tests are run on Linux/macOS (CI uses Ubuntu).

## Workflow

- Work on a branch and open a Pull Request to `main`. CI (syntax, typecheck, unit tests on 3 OSes, e2e) must pass.
- Commit messages describe the change, e.g. `fix(daemon): keep the worktree when a clone fails`, not `aaa`.
  People on the `main` update channel read the commit history.
- Behavior changes go in `CHANGELOG.md`; user-facing features are documented in `docs/guide.md`.
- All user-facing text (PWA, CLI/TUI) and docs are in English.
- Changes to the relay protocol must stay compatible with the hosted relay. Open an issue first if you need a new
  message or endpoint.

## License & CLA

Code in this repo is licensed under the [AGPL-3.0](LICENSE). By opening a pull request you agree to the
[Contributor License Agreement](CLA.md). Add this line to your PR description:

```
I have read and agree to the snugcode CLA (CLA.md).
```

The name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md).

## Releases ("stable" channel)

Daemons on the stable channel only install tagged releases.

```bash
npm version minor     # bump the version + commit + tag vX.Y.Z (keep it in line with the CHANGELOG)
git push --follow-tags
```

The Release workflow runs the tests, attaches `build.json` (PWA hashes, see `docs/security.md`), and publishes to
npm if the `NPM_TOKEN` secret is set.

## Security

Report vulnerabilities privately (see `docs/security.md`), not in public issues.
