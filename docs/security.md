# snugcode security: what is protected, and what isn't

This document describes snugcode's threat model honestly, so you can judge for yourself how far to trust it.
A summary of the security features is in [README → Security](../README.md#security).

## Parties involved

| Party | Trusted to | Not trusted to |
|---|---|---|
| **Your PC / runner** (daemon) | Store code, API keys, the GitHub token, and device secrets | — (if your own PC is compromised, everything goes with it) |
| **Your phone** (PWA) | Store the relay sign-in token & a device secret per PC (`localStorage`) | — |
| **Hosted relay** (snugcode.dev, Cloudflare Worker) | Forward messages, GitHub sign-in, the machine list, **serve the PWA code** | Read message contents |
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
   server that forwards the messages. Anyone who controls the relay deployment (the Cloudflare account or its deploy
   credentials) **could ship a PWA version that reads the device secret** from `localStorage` and then opens a channel
   to your PC. This is a general limit of every E2EE web app. Mitigations:
   - A strict CSP: no inline/third-party scripts, `connect-src` only to its own relay (XSS can't send data to
     another server).
   - **Verifiable builds** (see below): the served PWA must be byte-for-byte a build of this repo, and anyone can check.
   - The daemon on your PC is installed from this repo (or npm with provenance), never from the relay, and it only
     accepts phones that completed the PIN pairing.
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
built from the tagged code, and the hosted site is deployed from a pinned commit of this repo: the deploy fails if the
live digest doesn't match that build.

```bash
# The PWA currently served by the relay
curl -s https://snugcode.dev/build.json | jq -r .digest
# A build of the source code (same tag)
git checkout vX.Y.Z && npm ci && npm run build:web && jq -r .digest dist/web/build.json
# or download build.json from the GitHub release page and compare
```

A different digest means the served PWA is not a build of that code. To check a single file directly, compare
`curl -s https://snugcode.dev/agent/app.js | sha256sum` with `files["agent/app.js"]`.

## What the hosted relay sees

The relay is the hosted part of snugcode (accounts, PC linking, routing, cloud runners); its source isn't in this repo.
You don't have to take its word for anything, because everything it receives is decided by the open code here:
[`web/conn.js`](../web/conn.js) (phone), [`daemon/server.js`](../daemon/server.js) (PC), and
[`shared/crypto.js`](../shared/crypto.js) (encryption). [`test/dev-relay.mjs`](../test/dev-relay.mjs) is a small local
relay used by the tests; it speaks the same protocol, so it shows exactly what a relay gets to handle.

| The relay can see | The relay can't see |
|---|---|
| Your GitHub login & ID, your PC/runner names, when they are online | Prompts, replies, code, diffs, file contents |
| IP addresses, and the size & timing of encrypted frames | Your PIN, API keys, ChatGPT sign-in, GitHub token |
| Early-access plan reservations you make on the website | Which repos or models you use |

## Reporting a vulnerability

Don't open a public issue. Email the repo owner (see their GitHub profile) with reproduction steps; reports
are answered as quickly as possible and noted in the CHANGELOG once fixed.
