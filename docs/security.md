# snugcode security: what is protected, and what isn't

This document describes snugcode's threat model honestly, so you can judge for yourself how far to trust it.
A technical summary of the security features is in [README → Security](../README.md#security) and
[`master.md` §4](../master.md).

## Parties involved

| Party | Trusted to | Not trusted to |
|---|---|---|
| **Your PC / runner** (daemon) | Store code, API keys, the GitHub token, and device secrets | — (if your own PC is compromised, everything goes with it) |
| **Your phone** (PWA) | Store the relay sign-in token & a device secret per PC (`localStorage`) | — |
| **Relay** (Cloudflare Worker) | Forward messages, GitHub sign-in, the machine list, **serve the PWA code** | Read message contents |
| **AI agent** | Do the task inside the session folder | Read credentials, push without permission, change hooks/tool configuration |
| **Model provider** (Anthropic, OpenAI, …) | Process the prompts & code the agent sends | — (they see everything the agent reads) |

## What is protected

- **Conversations, code, diffs, the PIN, and API keys** can't be read by the relay: pairing uses a PAKE (CPace) and every
  message is end-to-end encrypted (XChaCha20-Poly1305). A relay that only *eavesdrops* learns nothing, and can't
  guess the PIN offline.
- **Credentials don't reach the agent**: agent processes only hold a local token; the `~/.snugcode` data folder is denied
  for every file tool and (under auto-approve / Codex) by the OS sandbox.
- **Linking a PC to an account** requires an explicit confirmation *after* the GitHub sign-in (a POST with a signed token).
  A link from someone else can't quietly link their PC to your account.
- **Remote actions** (`git push`, `gh pr create`, …) always ask, at every autonomy level.

## What is NOT protected (limits you should know)

1. **The relay serves the PWA code.** End-to-end encryption in the browser means the encryption code comes from the same
   server that forwards the messages. Anyone who controls the relay deployment (the Cloudflare account, the
   `CLOUDFLARE_API_TOKEN` token, the Deploy workflow, or this repo) **could ship a PWA version that reads the device
   secret** from `localStorage` and then opens a channel to your PC. This is a general limit of every E2EE web app. Mitigations:
   - A strict CSP: no inline/third-party scripts, `connect-src` only to its own relay (XSS can't send data to
     another server).
   - **Verifiable builds** (see below): compare the served PWA with a build of the source code.
   - **Self-host the relay** (see below) if you don't want to trust the public relay.
2. **Prompt injection.** The agent reads READMEs, issues, and command output that may contain malicious instructions.
   The permission policy, the risk levels on permission cards, and the OS sandbox limit the impact, but **commands you
   allow run as your user** (outside auto-approve, without a sandbox). Read high-risk commands before
   allowing them.
3. **Text-pattern command detection** (push, credential files, risk levels) is a UX safeguard, not a security
   boundary. A script that calls `git push` from inside a file isn't detected as a push.
4. **Model providers** see everything the agent reads and writes, including file contents in the repo.
5. **Computer mode & the PTY terminal** deliberately give access to the whole PC (the terminal has no sandbox).
6. **A lost phone**: anyone who opens the PWA on that phone can use your PC. Revoke it from the app
   (PC settings → Devices), with `snugcode revoke all` on the PC, and with *Sign out of all devices*.

## Verifying the PWA you use

Every build writes `build.json` with the SHA-256 of every served file. GitHub releases attach the `build.json`
built from the tagged code, and the Deploy workflow makes sure the relay serves the build of a commit that passed CI.

```bash
# The PWA currently served by the relay
curl -s https://snugcode.dev/build.json | jq -r .digest
# A build of the source code (same tag)
git checkout vX.Y.Z && npm ci && npm run build:web && jq -r .digest relay/public/build.json
# or download build.json from the GitHub release page and compare
```

A different digest means the served PWA is not a build of that code. To check a single file directly, compare
`curl -s https://snugcode.dev/agent/app.js | sha256sum` with `files["agent/app.js"]`.

## Self-hosting the relay

The relay is one Cloudflare Worker + Durable Objects (the free plan is enough for personal use).

1. Fork this repo. Create a GitHub **OAuth App** (Settings → Developer settings → OAuth Apps) with the callback
   `https://<worker-name>.<account>.workers.dev/auth/callback`.
2. In `relay/wrangler.jsonc`: change `GITHUB_CLIENT_ID`, `PUBLIC_URL` (your address), empty `LEGACY_HOSTS`, and set
   `RUNNER_REPO` to your fork (for Codespaces runners).
3. Secrets: `cd relay && npx wrangler secret put GITHUB_CLIENT_SECRET` and `npx wrangler secret put TOKEN_SECRET`
   (a long random string, e.g. `openssl rand -hex 32`).
4. Deploy: `npm run deploy` (or set `CLOUDFLARE_API_TOKEN` in your fork's Actions so the Deploy workflow runs after
   CI passes). If you don't use the alias worker, `npx wrangler deploy` in `relay/` is enough.
5. On the PC: `snugcode setup --relay https://<your-address>` (or the installer:
   `curl -fsSL https://<your-address>/install.sh | SNUGCODE_RELAY=https://<your-address> sh`). Open
   `https://<your-address>/agent/` on your phone.

The PWA's CSP automatically allows WebSockets to `PUBLIC_URL` & `LEGACY_HOSTS` from `wrangler.jsonc` (or
`SNUGCODE_WS_HOSTS=host1,host2 npm run build:web`).

## Reporting a vulnerability

Don't open a public issue. Email the repo owner (see their GitHub profile) with reproduction steps; reports
are answered as quickly as possible and noted in the CHANGELOG once fixed.
