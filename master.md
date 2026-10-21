# snugcode — Master Project Documentation

> **A remote coding agent on your own PC (or a cloud runner), fully controlled from your smartphone — any model, in its best harness (Claude Agent SDK / Codex).**  
> *Work on the repositories on your local PC from anywhere: review code, edit, commit, push, open PRs, and run shell commands straight from your phone.*

---

## 1. Executive Summary & Product Vision

**snugcode** is a *remote agentic coding* platform that lets users run and control coding agents — the **Claude Agent SDK** for Claude models & Anthropic/OpenAI-format endpoints, the official **Codex** for GPT models — on their local computer (PC/laptop) directly from a mobile device (phone/tablet) through a modern Progressive Web App (PWA), as well as from the PC terminal (TUI) at the same time. It also works without a PC: the same daemon runs as a **cloud runner** in the user's own GitHub Codespaces or in a Docker container (see §3 → Cloud runner).

The public website is **snugcode.dev**: a landing page at `/` and the app (**snugcode agent**) at `/agent/`.

### Design Philosophy
1. **Compute Stays on the Local PC**: All source code, compilers, runtimes (Node, Python, Docker, etc.), large files, and build processes live on the user's PC. The phone is only a smart remote control (thin client).
2. **No Complicated Network Configuration**: No public IP, port forwarding, VPN, Tailscale, ngrok, or rented cloud VPS needed. Both the PC and the phone make outbound connections (*outbound WebSocket*) to the Cloudflare relay.
3. **Zero-Knowledge Security & Modern Cryptography**: All communication between phone and PC is *end-to-end* encrypted (E2EE) using a PAKE (CPace over the Ristretto255 curve) and XChaCha20-Poly1305. The relay on Cloudflare Workers can't read messages, source code, the PIN, or any sensitive data.
4. **Credential Isolation**: Model connections (official/router API keys, ChatGPT sign-in) and the GitHub token are **stored on the daemon machine** (`~/.snugcode/secrets.json` & `~/.snugcode/codex` on the PC, or on the cloud runner's disk). Keys entered from the phone are sent over the E2EE channel and never returned to the phone; the relay never sees them; agent processes only hold a local loopback-proxy token.
5. **Mobile-First UX**: The phone interface is designed for touch-screen comfort: 1-tap permission approval buttons (*permission prompts*), colored mini-diff previews, haptic feedback, auto-resizing input, and handling of the virtual keyboard viewport.
6. **Best Harness per Model, No Central Router**: Model traffic goes straight from the daemon machine to the provider in its native format. snugcode doesn't forward subscriptions through unofficial paths (Claude Pro/Max subscriptions & Gemini CLI sign-ins are forbidden for third-party apps); ChatGPT sign-in is run through the official Codex (allowed by OpenAI).

---

## 2. System Architecture

The high-level communication flow of the `snugcode` architecture:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        SMARTPHONE / BROWSER                            │
│  Progressive Web App (PWA) — snugcode agent (snugcode.dev/agent/)      │
│  • Local encryption via WebCrypto & @noble crypto                      │
│  • One-time PIN pairing via CPace (Ristretto255)                       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ wss:// (E2EE Encrypted Payload)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 CLOUDFLARE WORKERS + DURABLE OBJECTS                   │
│                     snugcode Relay (Zero-Knowledge)                    │
│  • Alias worker `snugcode`: site + service binding to `pocketcode-relay`│
│  • Hub DO (1 per GitHub user): routes phone connections to the right PC│
│  • Pending DO: bridges PC linking through a browser sign-in            │
│  • The relay only forwards encrypted bytes; it CAN'T read messages     │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ wss:// (Outbound WebSocket Connection)
┌───────────────────────────────────┴────────────────────────────────────┐
│          USER'S PC (DAEMON SERVICE) — or a cloud runner                │
│  daemon/server.js (Background process via Windows/macOS/Linux service) │
│  ├─ Keep-Awake Manager (Away Mode win32 / caffeinate / systemd)        │
│  ├─ Local IPC Pipe/Socket (connection for the `snugcode` terminal TUI) │
│  ├─ Git Worktree Manager (isolated worktree per session; or Computer)  │
│  ├─ Local Loopback Proxy (127.0.0.1: per-connection token, translator) │
│  ├─ Claude Agent SDK  (Claude models / Anthropic & OpenAI endpoints)   │
│  └─ Codex app-server  (GPT models: ChatGPT sign-in / Responses API)    │
│         │ HTTPS (through the loopback proxy)  │ git / REST API         │
│         ▼                                     ▼                        │
│  ┌──────────────────────┐             ┌───────────────────────┐        │
│  │ The user's model     │             │        GitHub         │        │
│  │ providers: Anthropic,│             │ (clone, push, PR)     │        │
│  │ OpenAI, Gemini, …    │             └───────────────────────┘        │
│  │ or a router (9router)│                                              │
│  └──────────────────────┘                                              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Main Repository Components

The `snugcode` repository is built modularly as a lightweight monorepo without big frameworks (modern Vanilla JS with Node.js 22+ native modules):

| Directory / File | Role & Description |
|---|---|
| `daemon/cli.js` | Main CLI (`snugcode setup`, `login`, `start`, `stop`, `restart`, `update`, `clean`, `pin`, `cloud`, etc.); with no command it opens the TUI (`--pick`, `--computer`). `snugcode cloud` wraps the daemon in a supervisor. |
| `daemon/autostart.js` | Cross-platform autostart (Windows Startup `.vbs`, launchd `dev.snugcode`, systemd user `snugcode`), automatically synced to the active CLI path on start/update, migration of old `pocketcode` entries. |
| `daemon/cleaner.js` | Cleaner for orphaned worktrees/repos/logs (`safeRm` copes with read-only files & Windows locks); base clones are kept 3 days after their last session is deleted. Runs at start, after deleting a session, every 30 minutes, on `snugcode clean`, `/clean`, and the button on the phone. |
| `daemon/config.js` | Data location (`~/.snugcode`, changeable via `SNUGCODE_HOME`), atomic read/write of `config.json` & `secrets.json`, IPC path. |
| `daemon/defaults.js` | Defaults: relay URL, default router URL for router keys without a URL, GitHub OAuth client ID, package specs (can be overridden with `SNUGCODE_*` env vars). |
| `daemon/nativebin.js` | Per-platform detection of the native Claude binary (`claude.exe`) from the Agent SDK's optional packages. |
| `daemon/server.js` | Core daemon: relay WebSocket connection (token via subprotocol when the relay supports `wsProto`; heartbeat with a `DEAD_MS` `pong` deadline, half-dead sockets are reconnected), local IPC pipe, phone pairing, Web Push (per-phone level: `all`/`important`, permission buttons in notifications), and the idle watchdog for cloud runners. |
| `daemon/rpc.js` | RPC method table (input validation; `info.caps` for feature detection), including `autonomy` (autonomy presets) and `budget` (session cost limit). |
| `daemon/sessions.js` | Session manager (`SessionManager` & `Session`): three kinds of sessions (repo/worktree, local folder from the terminal, Computer), per-model engine selection with the same permissions & checkpoints, streaming event parsing, permission gating (`askPermission`), the PreToolUse hook, and direct shell execution (`!`). |
| `daemon/engine-claude.js` | Claude Agent SDK engine: `query()` options (trimmed tool list, subagents, snugcode MCP, sandbox under auto-approve, `settingSources: []` + project `CLAUDE.md`), Read/Grep widening hook for non-Claude models. |
| `daemon/engine-codex.js` | Codex engine: one `codex app-server` process per session (OS sandbox, MCP bridge) and `decideCodex` (Codex permissions through the snugcode policy). |
| `daemon/engine-gemini.js` | Gemini CLI engine: one `gemini --acp` process per session (local proxy token, snugcode's own `GEMINI_CLI_HOME`), fallback to the Claude Agent SDK when Gemini CLI can't be installed, and `decideGemini` (Gemini tool-call permissions through the snugcode policy). |
| `daemon/gemini.js` | Gemini CLI: installs `@google/gemini-cli` (version pinned in `gemini-version.json`), snugcode settings & `GEMINI.md`, ACP JSON-RPC client (`AcpRpc`), `GeminiAgent` (ACP events → snugcode events, `fs/read_text_file`/`fs/write_text_file` through snugcode, plan mode, `session/load`), project instructions. |
| `daemon/permissions.js` | Permission policy shared by all engines (pure functions): snugcode data folder, repo config files (`.claude/`, `.codex/`, `.gemini/`, `.mcp.json`, `.git/`), push to remotes, sandbox-escaping commands, "Always" rules. |
| `daemon/files.js` | File explorer from the phone: `resolveIn` (realpath; rejects anything outside the session folder & the snugcode data folder), folder listing (hides `.git` & symlinks leading outside), reading text/images (binary detection, hash), writing with hash conflict detection, `splitPatch` + `revertChange` (revert one hunk via `git apply -R`, or one file). |
| `daemon/pty.js` | Interactive terminal: `@lydell/node-pty` (optional), at most 4 PTYs per session, a 256 KB scrollback replayed on reopen, output batched every 16 ms, one subscriber per terminal (the phone that opened it last). |
| `daemon/keychain.js` | `snugcode keychain on`: `secrets.json` encrypted with XChaCha20-Poly1305 using a key in the OS keychain (macOS `security`, Secret Service `secret-tool`, DPAPI on Windows → `secrets.key`); the key is cached per process, with a clear message when the keychain is locked. |
| `daemon/sandbox.js` | OS sandbox for the Claude engine's Bash: support detection (bubblewrap + socat + namespace probe / Seatbelt), the SDK `sandbox` option (deny reading credentials, write only to the worktree & package caches, git hooks/config locked), and `info/exclude` for sandbox placeholders. |
| `daemon/proxy.js` | Multi-route local loopback HTTP proxy (`127.0.0.1`): one local token per connection+format, the real key injected per request. Routes `anthropic` (forwarded as is; routers only: header & `_ide` sanitizing), `openai` (translated, see `translate.js`), `responses` (Codex → OpenAI endpoint). |
| `daemon/translate.js` | Translator between Anthropic Messages ⇄ OpenAI Chat Completions (requests, SSE streams, errors, `count_tokens`): tool schemas & Gemini 3 *thought signatures*, effort from the ID suffix → `reasoning_effort`, cache tokens → `cache_read_input_tokens`. |
| `daemon/providers.js` | Model connections: API key/endpoint detection (key patterns + API tests, format detection without calling a model), model list per connection (5-minute cache), model → connection/engine routing (`resolveRoute`), model tests (*probe*), migration of old routers. |
| `daemon/codex.js` | Codex engine: installs `@openai/codex` (version pinned in `codex-version.json`), JSON-RPC client for `codex app-server`, sandbox profile (denies reading the snugcode data folder), ChatGPT sign-in with a device code, ChatGPT model list, and `CodexAgent` (Codex events → snugcode events, permissions through the snugcode policy). |
| `daemon/mcp-bridge.js` | Stdio MCP server for the Codex engine: `dev_*`/`preview_screenshot` tools are forwarded to the daemon over a local channel with a per-session bridge token (it can only call that session's dev tools). |
| `shared/providers.js` | Provider catalog (URLs, key patterns, formats), rejected keys (Claude subscription tokens, Google OAuth, admin keys), `<connection>:<model>` model references, and engine selection per connection+model (`engineFor`). |
| `shared/engine-table.js` | Default engine table per connection kind + model pattern (filled from `npm run bench`), read by `engineFor` before the format rules. |
| `scripts/bench.mjs` | `npm run bench`: the same coding tasks (fix a bug, add a feature, rename across files) on each engine per model, graded by tests; a pass/time/token table + a suggested `engine-table.js` row. Temporary data folder, connections copied from this PC. |
| `daemon/updater.js` | Self-update (both `git` and `npm -g` installs): `stable` channel (tagged releases, default) / `main`, rollback to the previous version, scheduled graceful restart. |
| `daemon/keepawake.js` | Anti-sleep service: keeps the PC's CPU & network on while the daemon runs. |
| `daemon/github.js` | Git & GitHub REST API integration: creating `git worktree`s, branching, auto-prune, status, diff, commit, push, and PRs. |
| `daemon/ghauth.js` | GitHub device-flow authentication manager and token status change notifications. |
| `daemon/tui.js` | Interactive Terminal User Interface (TUI) on the PC (`snugcode` / `snug`). |
| `daemon/term.js` | Terminal text for the TUI: colors, ANSI-aware display width, line wrapping, markdown → ANSI. |
| `daemon/toolchain.js` | Command shell (PowerShell/bash) + automatic pnpm/yarn through corepack when not installed on the PC. |
| `daemon/procs.js` | Background processes per session (dev servers/watchers): ring-buffer logs, port detection, killing a whole process tree. |
| `daemon/tunnel.js` | Previews for the phone: Cloudflare quick tunnel + local token gate (Host/Origin rewrite, HMR WebSockets). `cloudflared` is downloaded by version + SHA-256 from `cloudflared-version.json`. |
| `daemon/project.js` | Setup/dev command detection, per-repo `.env` templates (`~/.snugcode/env`). |
| `daemon/browser.js` | Screenshots + console logs via headless Chrome/Edge (CDP), without Playwright. |
| `daemon/devtools.js` | In-process MCP tools for the agent: `dev_start`, `dev_stop`, `dev_logs`, `dev_list`, `preview_screenshot` (agent: DPR 1, `image:false` option, summarized console logs). |
| `daemon/prompt.js` | snugcode's system prompt additions: only agent behavior rules (±1.9 KB), sent with every model request. Two variants: repo sessions (`SNUGCODE_SYSTEM_PROMPT`, stay in the worktree, no `git push`) and Computer mode (`SNUGCODE_COMPUTER_PROMPT`). |
| `daemon/agents.js` | Redefinitions of the built-in subagents (Explore, Plan, general-purpose, claude) at low effort; their model is the session's light model. |
| `daemon/checkpoint.js` | Worktree snapshots per prompt (temporary git index) and rewind. |
| `daemon/webpush.js` | Encrypted Web Push (RFC 8291 + VAPID) to the phone when the PWA is closed. |
| `daemon/runner.js` | Cloud runner (no PC): `bootstrapCloud` fills config/secrets from env idempotently (machine token, PIN, relay, router, model), `stopRunner` stops an idle runner (Codespaces API with a token from the phone, or exiting the container), `reportStatus` reports configuration failures to the relay, `tickUsage`/`usageSummary` track estimated core-hours per month (`runner-usage.json`, shown in the runner menu). |
| `.devcontainer/`, `Dockerfile` | Codespaces runner: `install.sh` (onCreate, included in prebuilds when configured: Chromium, bubblewrap + socat, the snugcode package), `start.sh` (postStart: `snugcode cloud` in the background; falls back to the repo code if the global package fails), `lib.sh` (data folder `/workspaces/.snugcode` or `~/.snugcode`, logs, stage reports to the relay). `Dockerfile`: the same image for VPS/Fly.io (volume `/data`). |
| `relay/src/index.js` | Cloudflare Worker `pocketcode-relay` + Durable Objects (`Hub` and `Pending`) as a secure message broker. See the endpoint table below. |
| `relay/src/headers.js` | Security headers for the site (strict CSP) — one source for the assets' `_headers` and relay responses. |
| `relay/src/alias.js` | Alias worker `snugcode` (public address `snugcode.dev`): serves the landing page (`/`) and the snugcode agent PWA (`/agent/`), and forwards every other request to the relay through a service binding. |
| `web/app.js` | PWA entry point: boot, service worker, reconnect when the app becomes visible again, data import from the old address (`#import=`), Codespaces token from the fragment (`#gh=`). |
| `web/sw.js` | Stale-while-revalidate service worker; cache name = hash of the assets (filled in by `build:web`). Served at the root (`/sw.js`, scope `/`) so registrations & push subscriptions of phones that installed the PWA before it moved to `/agent/` stay valid. |
| `landing/` | snugcode Cloud landing page at `/` (static HTML/CSS/JS, copied by `build:web`). `boot.js`: old links to `/` (installed apps, `#open=`, `#gh=`, `#import=`) are forwarded to `/agent/`; the token from `#login=` is stored in `pc.token` (shared with the agent). The agent buttons open a Sign in/Sign up modal when not signed in. |
| `web/ui/*.js` | PWA screens per module: `dom` (elements, icons, toasts, header/sheet), `auth` (sign-in & machine list, removing machines from the list), `machine` (PC connection, pairing, updates, PC GitHub sign-in, the PC settings menu), `sessions` (home, drawer, new session: Repository/Computer tabs), `session`, `renderer` (agent events), `run`, `git` (diff + per-hunk review), `files` (explorer & editor), `terminal` (xterm.js, loaded separately from `xterm.js`), `model-picker`, `push`, `progress` (stage bar + time-left estimate); shared state in `state.js` (`app.conn`, `app.current`, `app.me`). |
| `web/eta.js` | DOM-free progress calculation: per-stage bars that slow down near the end, time left, stage durations learned per phone. |
| `web/conn.js` | Encrypted phone ↔ PC connection: PIN pairing, device auth, text/binary E2EE channel, RPC with timeouts (30 s / 3 min for long operations), heartbeat & `wake()` (tests the socket when the app is reopened / the network comes back). |
| `web/install.sh`, `web/install.ps1` | One-line installers served by the relay: check Node.js 22+ & git, install snugcode, `snugcode setup` (`SNUGCODE_RELAY` for your own relay). |
| `web/codespaces.js` | DOM-free GitHub Codespaces client: find the runner fork, encrypted (sealed box) secrets scoped to the fork repo, create/find/start/stop/delete codespaces. |
| `web/ui/cloud.js`, `web/ui/settings.js` | Cloud runner wizard & lifecycle; machine settings from the phone: Models & API keys (connections, ChatGPT sign-in with a device code, key type detection while typing), devices, PIN. |
| `shared/sealedbox.js` | libsodium `crypto_box_seal` (X25519 + XSalsa20-Poly1305) for Codespaces secrets. |
| `web/md.js` | Lightweight markdown for agent text + `stableCut` for incremental rendering while streaming. |
| `web/index.html` & `style.css` | Structure and styling of the chat-style mobile interface: light/dark themes (CSS tokens), serif agent text, drawer, card composer, transform/opacity animations. |
| `shared/crypto.js` | Shared cryptography (CPace, Ristretto255, X25519, XChaCha20-Poly1305, Scrypt, HKDF). |
| `shared/events.js` | Agent session event model shared by daemon/PWA/TUI: event types (JSDoc), structured TodoWrite plans, activity labels, completion summaries, `EventCursor` (duplicate event filter). |
| `shared/risk.js` | Risk levels for permission requests (`commandRisk`, `permRisk`: low/medium/high + reason) and autonomy presets (`ask`/`balanced`/`trusted`/`auto` ⇄ session flags `askEdits`/`autoLow`/`auto`). UX heuristics, not a security boundary. |
| `shared/models.js` | AI model ID normalization, grouping of reasoning-effort variants into a virtual slider. |
| `scripts/build-web.mjs` | Build script: landing page to the root of `relay/public`, PWA to `relay/public/agent/`, `sw.js`/fonts/installers at the root (used by both workers); `_headers` with a CSP whose `connect-src` is only the relay hosts (`PUBLIC_URL`/`LEGACY_HOSTS` or `SNUGCODE_WS_HOSTS`); `build.json` with the SHA-256 of every file for build verification. |
| `scripts/docs-images.mjs`, `scripts/icons.mjs` | `npm run docs:images` (README images & GIFs from the real UI, needs the dev relay) and `npm run icons` (PNG/maskable/apple-touch from the SVG). |
| `tsconfig.json` | `tsc --checkJs` for all JS (daemon, shared, web); the relay has its own tsconfig with `wrangler types`. `npm run typecheck`, also in CI. |
| `.github/workflows/` | `ci.yml`: syntax check, typecheck, unit tests (Linux/Windows/macOS), site bundle, then e2e (agent, cloud runner, UI) on Linux. `deploy.yml`: after the CI workflow passes on `main` (`workflow_run`, using the commit that passed) and when `relay/`, `web/`, `landing/`, `shared/` changed (or manually) → `npm run deploy`, then a smoke test that the served `build.json` = the build; needs the `CLOUDFLARE_API_TOKEN` secret. `release.yml`: tag `vX.Y.Z` → tests, `build.json` attached to the GitHub release, and `npm publish --provenance` if the `NPM_TOKEN` secret exists. |
| `test/` | `features.test.js` (`npm test`: explorer, edit conflicts, hunk revert, PTY, keychain, Gemini engine, runner quota estimate), `e2e-gemini.mjs` (`npm run test:e2e:gemini`: real Gemini CLI vs a fake Gemini API — shell permissions, writing files through ACP, `session/load`, plan mode, keys never reach Gemini CLI), `e2e-harness.mjs` (shared setup), `e2e-ui.mjs` (`npm run test:ui`: PWA in Chrome + TUI in a pty), `unit.test.js` & `providers.test.js` (`npm test`, also run by CI on Linux/Windows/macOS), `e2e-connections.mjs` (`npm run test:e2e:connections`: connections from the phone, OpenAI-only endpoints through the translator, real Codex with permissions/sandbox/MCP bridge), `e2e-agent.mjs` (`npm run test:e2e`: phone → local relay → daemon → Agent SDK → mock 9router; needs `npm run dev:relay`), `e2e-cloud.mjs` (`npm run test:e2e:cloud`: provision → `snugcode cloud` → automatic pairing → settings from the phone), `worktree.it.mjs` (git integration, needs internet), `e2e-phone.mjs` (manual phone simulation). |

### Cloud runner (no PC)
Machines on the relay don't have to be PCs. `POST /api/machines/provision` (signed-in account) registers a `kind: 'cloud'`
machine and returns its machine token to the PWA. The PWA then:
1. creates a random PIN (stored on the phone for automatic pairing),
2. stores the machine token, PIN, and relay URL as **Codespaces user secrets** encrypted on the phone with a
   sealed box to the GitHub account's public key, scoped to the user's snugcode fork repo,
3. creates a codespace from that fork (`display_name = "snugcode <mid>"`, 240-minute idle timeout as a safeguard).

In the codespace, `.devcontainer/start.sh` runs `snugcode cloud`: `bootstrapCloud` reads env (idempotent —
changes from the phone such as a new PIN/key aren't overwritten when the runner restarts), removes secret env vars, then
runs the daemon under a **supervisor** (exit 75 = restart/update from the phone, exit 0 = stop; crashes and signals
hitting the daemon — the daemon exits with 128+signal — start it again; on Codespaces the supervisor ignores
SIGTERM so `pkill node` doesn't kill the runner while the codespace is running). A daemon with
`runtime: 'cloud'` doesn't run anti-sleep/autostart, may start without a model connection (filled in from the phone via the RPCs
`connAdd`/`chatgptLogin`, or the `SNUGCODE_API_KEY` env var), and checks every minute whether it is idle (no agent/`!command`/dev server/tunnel, no
phone with the app open). After `idleStopMinutes` (default 30) the codespace is stopped through the GitHub API with
the `codespace` token sent by the phone (RPC `runnerConfig`). When a sleeping runner is opened again, the PWA starts it (`/start`);
a codespace that has been running for 45 seconds without the runner connecting/reporting is restarted once (stop → start) so that
`postStartCommand` runs the runner again, and after that 6 minutes without a report becomes an error with a hint about the log.

Until the runner is connected, the `.devcontainer/` scripts (and `snugcode cloud` when its configuration fails) report
their stage to the relay (`POST /api/runner/status` with the machine token: `stage` installing/starting/error, `step`
chromium/install/start, a message + the last log lines). The relay stores it as `boot` in the machine list, and the PWA
uses it for the progress bar and error messages; a codespace running for >6 minutes without a report is considered failed
(the secrets didn't arrive / the script didn't run). Limits: at most 3 cloud machines per account (`provision` answers 409), and
the wizard only creates one Codespaces runner (the rest is *Recreate*). A Codespaces token on the phone that GitHub rejects (401)
is dropped immediately and the PWA offers "Reconnect". Machines (PCs and runners) can be removed straight from the machine
list without being connected.

### Relay endpoints
| Endpoint | What it does |
|---|---|
| `GET /auth/login?kind=user\|machine\|gh` | GitHub sign-in (web flow). The `state` token has its own kind (not valid as a user token). `user` → token at `<next>#login=` (`next` = `/` or `/agent/`, default `/agent/`; `signup=1` shows account creation on GitHub); `machine` → the PC code is checked, then **after** signing in a confirmation page (PC name, code, account) is shown with a POST form to `/auth/machine/confirm`; `gh` → a `codespace`-scoped token for the PWA at `#gh=…&ghlogin=…` (not stored by the relay). On old hosts it redirects to `PUBLIC_URL`. |
| `POST /auth/machine/start`, `GET /auth/machine/poll` | PC linking from `snugcode setup` through the `Pending` DO (the code is valid for 15 minutes). |
| `POST /auth/machine/confirm` | PC linking confirmation: a signed `link` token (PC code + account, valid for 10 minutes) that only exists on the confirmation page of the signed-in user; URL parameters can't bypass it. |
| `POST /api/renew` | A new sign-in token (30 days) for a token that is still valid and not revoked; the PWA calls it at most once a day. |
| `GET /api/me`, `GET /api/machines` | Account & machine list (`kind`, `provider`, `online`, `lastSeen`, `boot`). Max 20 machines per account. |
| `POST /api/logout-all` | Revoke every sign-in token of the account (the Hub stores `revokedBefore`; tokens with an older `iat` are rejected, connected phones are closed with 4005). |
| `POST /api/machines/provision` | Register a cloud runner without signing in from the machine itself; returns the machine token to the PWA. |
| `POST /api/runner/status` | Runner stage report (machine token). |
| `DELETE /api/machines/<mid>` | Remove a machine; its PC & phone sockets are closed (4003). |
| `GET /ws/machine`, `GET /ws/phone?mid=` | Daemon & phone WebSockets; text frames or binary `[cid][payload]`. Token via the `snugcode, t.<token>` subprotocol (the relay answers `snugcode`), or `?token=` for old clients. A machine is online = it has a socket that `ping`ed in the last 80 seconds (answered automatically); sockets without pings are closed with 4006 and the machine is marked offline (machines that die suddenly don't close their socket). |
| `GET /api/health` | `devAuth`, `wsProto` (WebSocket token via subprotocol), `runnerRepo`, and the old-host markers (`legacy`, `publicUrl`). |
| `GET /build.json`, `/install.sh`, `/install.ps1` | Static assets: PWA build hashes, one-line installers. |

Per-IP rate limit (binding `LIMITER`, 30/minute) for `/auth/login`, `/auth/machine/start`, `/auth/machine/confirm`, `/api/machines/provision`. The full threat model (including the limit that the relay also serves the PWA code) is in [`docs/security.md`](docs/security.md). Site assets are served with a strict CSP (`relay/src/headers.js`).

---

## 4. End-to-End Encryption (E2EE) & Security

`snugcode`'s security is designed on a **Zero Trust** principle towards the relay server:

### A. Initial Pairing (CPace PAKE)
- The user sets a simple PIN (6–12 letters/digits, case-insensitive) on the PC when running `snugcode setup`.
- The PIN is hashed on the PC with the **Scrypt KDF** (N=2¹⁵) salted with the machine ID (`pocketcode-pin:<machineId>`; the `pocketcode-*` labels in `shared/crypto.js` are protocol identifiers and were deliberately not changed during the rebrand), producing a Password-Related String (PRS). The original PIN is never stored in plaintext.
- The PIN can be changed from the PC (`snugcode setup`/`snugcode pin`, effective after restarting the daemon) or from an already-paired phone (RPC `setPin`, effective immediately). Cloud runners use a random PIN created by the phone and sent as a Codespaces secret, so the phone that created it is paired without typing a PIN.
- When a phone connects for the first time, a **CPace** key exchange (over the *Ristretto255* curve) takes place.
- The relay only acts as a hex message middleman. It can't crack the PIN offline (*offline dictionary attack resistant*).
- Against brute force, every 5 failed pairings lock pairing temporarily: 15 minutes, doubling with each subsequent lock (max ±16 hours). Attempts are counted at `pair1` (a guesser only needs to see `pair2` to test one guess). A successful pairing, `snugcode pin`, or the `setPin` RPC unlocks it (`config.js`: `pinAttempt`/`resetPinLock`).
- A successful pairing produces a permanent 256-bit shared secret (`deviceSecret`) stored in the phone's `localStorage` and in `~/.snugcode/secrets.json` on the PC.

### B. Session Channel Encryption
- Every time the phone reconnects, both sides perform an ephemeral **X25519** key exchange.
- Keys are derived together with the `deviceSecret` using **HKDF-SHA256**, producing a pair of independent symmetric **XChaCha20-Poly1305** keys (phone → PC and PC → phone).
- Messages carry a *monotonic sequence counter* to prevent *replay attacks*.
- **Proto 2 (binary channel)**: when the phone & relay support it (agreed during auth), messages are sent as binary frames `[version][nonce][ciphertext]` and large messages are split into 256 KB chunks, so history (4 MB), diffs (2 MB), and screenshots aren't cut off by the relay's 1 MB limit. Old clients/daemons keep using text frames.

### C. Machine settings from the phone
- RPCs `connAdd`/`connRemove`/`connections` (official/router API keys, detected & validated first; keys are never returned), `chatgptLogin`/`chatgptLogout` (Codex, device code), `configure` (old form: one router), `devices`, `revoke` (the device's connection is cut immediately), `setPin`, and `runnerConfig` (cloud runners only: Codespaces token for stopping itself, idle minutes).
- `GITHUB_TOKEN`, `GH_TOKEN`, Codespaces tokens, and runner bootstrap env vars (`SNUGCODE_MACHINE_TOKEN`, `_PAIR_PIN`, `_ROUTER_KEY`, `_GITHUB_TOKEN`) are removed from the daemon's environment at start (`scrubSecretEnv`), so they aren't inherited by the agent, Bash, dev servers, or `!commands`.

---

## 5. Session Workflow & Git Worktree Management

`snugcode` distinguishes three kinds of sessions, all visible from both the phone and the terminal:

### 1. Remote Sessions (via phone / PWA)
- The user picks a GitHub repository from their list of repositories.
- The daemon creates a base clone (*bare/base*) in `~/.snugcode/workspaces/<owner>__<repo>/_base`.
- Every new session gets an isolated **Git Worktree** directory at `~/.snugcode/workspaces/<owner>__<repo>/s-<sessionId>`.
- The worktree has its own branch (default `snug/<sessionId>`). The AI agent works purely inside that worktree, so it doesn't pollute other projects' *working trees*.
- Leftover lock files are cleaned up automatically (`.git/index.lock` stale pruning) and `git worktree prune` is run.

### 2. Local Sessions (via the PC terminal)
- The user just opens a terminal in any local project folder and types `snugcode` (or `snug`).
- That folder becomes a local session directly (*direct directory*, no clone).
- The session automatically shows up in the phone app with a **"terminal"** badge. The user can continue the conversation or monitor progress from the phone while walking away from the PC.
- Deleting a local session only deletes its history; the user's folder is never deleted. `.env` templates aren't available.

### 3. Computer Sessions (Computer mode)
- Created from the phone (New session → **Computer** tab, optional starting folder; default home), from the TUI (`/computer`, session picker), or with `snugcode --computer` / `-c` (current folder).
- Session meta: `computer: true`, `repo: 'Computer'`, `cwd` the chosen folder; no clone, worktree, or new branch. The system prompt uses `SNUGCODE_COMPUTER_PROMPT` (access to the whole computer, not limited to one repo).
- Permissions: file read and edit tools pass without asking **anywhere** (not just inside `cwd`), except in *Review edits* / plan mode. Non-read-only Bash and other tools still go through the permission prompt/auto-approve. Denial of the `~/.snugcode` data folder and the mandatory prompts for push/`gh` and `secrets.json` still apply.
- No checkpoints & rewind (the `rewind` RPC is rejected) and no `.env` templates. Git status/diff is attempted in `cwd`; if it isn't a repo, an empty result with `notRepo` is returned.
- Deleting the session only deletes the `.jsonl` history; files on the PC aren't touched.
- Note: this mode is also available on cloud runners (working inside the runner container).

### 4. Permission Gating
- The Claude Code AI agent can call various tools: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, etc.
- The SDK runs with `permissionMode: 'default'`, so every unsafe tool goes through `canUseTool` in the daemon.
- **Explicit tool list** (`AGENT_TOOLS`): `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent`, `AskUserQuestion`, `ExitPlanMode`, `WebFetch`, `WebSearch` + the MCP tools `mcp__snugcode__*`. `EnterPlanMode` is forbidden (plan mode is only set by the user).
- **Safe Tools**: `TodoWrite`, `WebSearch`, `ToolSearch`, `BashOutput`, subagents `Task`/`Agent`, non-executing dev tools (`dev_stop`, `dev_logs`, `dev_list`, `preview_screenshot` of localhost), and read tools (`Read`, `Glob`, `Grep`, `LS`) **whose target is inside the worktree** (or the agent's own Claude config folder) are allowed automatically. Reading outside the worktree, `WebFetch`, and screenshots of non-localhost URLs ask for permission (or auto-approve) so file contents can't be quietly sent out through prompt injection; `file:` screenshots always ask.
- **The `~/.snugcode` data folder** (API keys, Codex ChatGPT sign-in, GitHub token, device secrets, `.env` templates, binaries; except worktrees, plans, and *reading* the agent's own Claude config folder) is always denied for file tools, including under auto-approve. Writing to the Claude config folder is still denied because a `settings.json` there could install hooks. Bash commands that mention `secrets.json` or snugcode data subfolders always ask and can't be "Always allowed".
- **Checkpoints**: the per-prompt worktree snapshot runs in parallel with the agent's start-up; tools that can change files only run after the snapshot is done.
- **File edits**: `Write`/`Edit`/`MultiEdit` targeting the worktree apply immediately (every prompt has a checkpoint, so it can be rewound). *Review edits* (session menu on the phone / `/edits` in the terminal, stored as `askEdits`) makes every edit wait for approval with a mini-diff preview. Edits outside the worktree and in plan mode always ask.
- **`Bash` commands** that aren't read-only (Claude Code itself lets read commands like `ls`, `grep`, `git status` through) ask the user to decide:
  - *Allow* (once)
  - *Always* — uses Claude Code's suggested rule for that command (e.g. `Bash(npm test *)`), not all of Bash. The rule applies immediately in the running process, is stored as `allowRules` in `sessions/index.json`, and is passed via `settings.permissions.allow` to the next process. Compound commands (`npm test && rm …`) still ask for the part that doesn't match. Tools without a suggested rule (e.g. `dev_start`) use a per-tool "Always" as before.
  - *Deny*
- The `PreToolUse` hook runs for tools that can change files (`Bash`, `Write`, `Edit`, `dev_start`, …), including those that pass through rules without going through `canUseTool`: it holds them until the prompt checkpoint is saved, and forces a permission prompt (`permissionDecision: 'ask'`) for push/`gh pr create` and commands mentioning `secrets.json`, even when they match an "Always" rule such as `Bash(git *)`.
- **Critical actions**: commands that write to a remote — `git push` (including `git -C dir push`, `git -c k=v push`), `gh pr create|merge`, `gh release create`, `gh repo create|delete|fork` — **always ask for explicit permission** regardless of auto-approve, and can't be "Always allowed". Detection is based on the command's text pattern: a safeguard against agent mistakes, not a sandbox (a script that calls `git push` from inside a file isn't detected).
- **Risk levels & autonomy presets** (`shared/risk.js`): every permission card carries a `risk` (low/medium/high + reason) and `undo` (the change can be rewound). High risk is shown in red in the PWA without *Always* and doesn't carry a `pid` in Web Push (can't be answered from the notification). Presets: *Ask everything* (`askEdits`), *Balanced* (default), *Routine auto* (`autoLow`: low-risk Bash/`dev_start` — tests/lint/typecheck/builds without `; & | > $()` — pass without asking), *Full* (`auto`).
- **Session cost**: the Agent SDK's `total_cost_usd` is a running total per process (a process that resumes a transcript starts from the stored total); `Session.account` turns it into a per-turn `cost` + session `spent` (`meta.spentUsd`). `meta.budgetUsd`: a warning at 80%, `send` is rejected once it is reached.
- **⚡ Auto-approve mode**: the user can turn on the auto-approve toggle from the phone/terminal to let the agent work on its own without interruptions, except for the critical actions above.
- **OS sandbox under auto-approve** (`daemon/sandbox.js`): a regex blocklist isn't enough (`cat ~/.snug*/s*.json` gets through), so the `claude` process of auto-approve sessions runs with the Agent SDK `sandbox` option: `denyRead` on the data folder (same as the Codex profile), `allowWrite` only for `workspaces/` (or home in Computer mode) + package caches, `denyWrite` for git hooks & config, outbound network `*`. `autoAllowBashIfSandboxed: false`, so decisions still go through `askPermission`; Bash passes automatically only if that process is actually sandboxed (auto-approve turned on mid-process without a sandbox keeps asking until the next prompt). `dangerouslyDisableSandbox` always asks and can't be "Always". Measured with the real SDK: the worktree, `git commit`, and the `npm` registry keep working; the host's `localhost` isn't reachable, which is why it is only the default for auto-approve (`config.sandbox`: `auto` | `always` | `off`).
- **Repo configuration**: `settingSources: []` — the repo's `.claude/settings.json` isn't loaded (repo hooks/permissions/env/`apiKeyHelper` could be written by anyone); `CLAUDE.md` & `.claude/CLAUDE.md` are read by snugcode itself (`projectInstructions`, max 40 KB). Edits to `.claude/`, `.codex/`, `.mcp.json`, `.git/` always ask in both engines.

---

## 6. Model Connections, Engines (Harnesses) & Routers

### Connections
Users connect models from the phone (**PC settings → Models & API keys**, RPCs `connAdd`/`connRemove`/`chatgptLogin`), from the terminal (`snugcode connect`), or via runner env vars (`SNUGCODE_API_KEY`/`SNUGCODE_API_URL`). One connection = one credential, stored in `secrets.connections[id]` (`kind`, `key`, `anthropic`/`openai` URLs, `formats`). ID = the provider kind (`anthropic`, `openai`, `chatgpt`, `gemini`, `openrouter`, `deepseek`, `moonshot`, `zai`, `xai`, `groq`) or `router`, `router2`, … for routers/your own endpoints.

- **Detection** (`detectConnection`): forbidden keys are rejected with a reason (Claude subscription tokens `sk-ant-oat…`, Google OAuth `ya29.…`, admin keys). Key patterns determine provider candidates (`sk-ant-api…` → Anthropic, `AIza…` → Gemini, `sk-or-v1-…` → OpenRouter, `sk-proj-…` → OpenAI, `xai-…`, `gsk_…`, GLM keys, etc.); ambiguous keys (`sk-…`) are tested against several providers at once. Unrecognized keys need a URL (router). The endpoint format is detected with an empty POST body to `/v1/messages`, `/chat/completions`, `/responses` (400/422 = exists, 404/405 = doesn't) so no tokens are spent. Third-party Anthropic-format endpoints (DeepSeek, Kimi, GLM, OpenRouter) are verified the same way.
- **Model references**: `<connection>:<model id>` (e.g. `anthropic:claude-opus-5-5-high`, `chatgpt:gpt-5.5`). Models of the `router` connection are written without a prefix (`cc/claude-opus-5-5`), so old configs & sessions keep working; the old router (`config.routerUrl` + `secrets.routerKey`) is migrated automatically into a `router` connection and still mirrored to the old fields.
- **Model list**: `modelsAll` merges all connections (failing connections are reported separately); non-chat models (embeddings, audio, images) and models that declare no tool support are dropped.

### Engine per model
`engineFor(connection, model)` (shared/providers.js) picks the harness:

| Condition | Engine | Path |
|---|---|---|
| `chatgpt` connection | **Codex** | Codex's own ChatGPT sign-in (`CODEX_HOME`) |
| The endpoint has the Responses API and the model is GPT (or an `openai` connection) | **Codex** | Codex custom provider → proxy (`responses` route) |
| The endpoint has the Anthropic format | **Claude Agent SDK** | proxy (`anthropic` route), forwarded as is |
| A `shared/engine-table.js` row matches (currently: `gemini` connection + `gemini-*` models) | **Gemini CLI** | `GOOGLE_GEMINI_BASE_URL` → proxy (`gemini` route, native Gemini API format) |
| OpenAI Chat Completions only | **Claude Agent SDK** | proxy (`openai` route) + format translator |

`SNUGCODE_ENGINE=claude|codex|gemini` forces that engine when the endpoint supports it (also used by `npm run bench`). Sessions store the model reference, not the engine; switching to a model on another connection/engine creates a new agent process on the next prompt.

### Codex engine (`daemon/codex.js`)
- Installed once into `~/.snugcode/tools/codex` when first needed (version pinned; the app-server protocol is still experimental). One `codex app-server` process per session, reused across prompts; the Codex thread is stored in the session meta (`codexThreadId`) and resumed with `thread/resume`.
- `approvalPolicy: 'untrusted'`: every command goes to the daemon (`item/commandExecution/requestApproval`) and is decided by the same snugcode policy as the Claude engine (`decideCodex`): read-only actions according to Codex's parser pass (unless they touch the data folder), "Always" rules per command pattern, auto-approve, push/`gh` & `secrets.json` always ask. File changes inside the worktree are applied (except under *Review edits*/plan mode); `request_user_input` questions become AskUserQuestion cards on the phone.
- Sandbox: the `snugcode` permission profile (extends `:workspace`, network on) denies reading `secrets.json`, `config.json`, `codex/`, `claude/`, `env/`, `sessions/`, `daemon.log` at the OS level (bubblewrap/Seatbelt). Sandbox availability is tested once (`codex sandbox … echo`); when unavailable (containers without user namespaces) Codex runs without an OS sandbox, the user is told, and permissions still go through snugcode.
- The checkpoint is taken before a Codex turn starts (Codex has no "wait before tool" hook). Plan mode = a `readOnly` sandbox for that turn.
- snugcode dev tools are available through `mcp_servers.snugcode` → `daemon/mcp-bridge.js` → the daemon's local channel (per-session bridge token; `dev_start` & screenshots of external URLs still go through permissions).
- Events: message & reasoning deltas → text/thinking, `commandExecution`/`fileChange`/`mcpToolCall`/`webSearch` → tool cards + results, `turn/plan/updated` → plan card, `thread/tokenUsage/updated` → tokens & cache per turn, `turn/completed` → completion summary.

### Gemini CLI engine (`daemon/gemini.js`, `daemon/engine-gemini.js`)
- Installed once into `~/.snugcode/tools/gemini` (version pinned in `gemini-version.json`); if that fails (e.g. offline), Gemini models run on the Claude Agent SDK through the translator with a note in the session. One `gemini --acp` process per session; the Gemini session is stored in the meta (`geminiSessionId`) and resumed with `session/load` (the replayed history is ignored).
- `gateway` auth method: `GOOGLE_GEMINI_BASE_URL` = the local proxy, `GEMINI_API_KEY` = a local token (sent as `x-goog-api-key`, swapped by the proxy for the real key). Other Google credentials in env are dropped. `GEMINI_CLI_HOME` = `~/.snugcode/gemini/<repo|computer>` containing `settings.json` (auto-update, stats & telemetry off, folder trust on, `enter_plan_mode` disabled) and `GEMINI.md` = `geminiPrompt`.
- The working folder is never marked trusted: the repo's `.gemini/settings.json` (MCP, hooks, `discoveryCommand`) isn't loaded. As a consequence Gemini CLI also doesn't run stdio MCP servers (no `dev_*` tools; dev servers through Gemini's background shell) and doesn't load project instructions — `GEMINI.md`/`AGENTS.md`/`CLAUDE.md` in the root of the working folder are injected into the first prompt of a new session.
- Permissions (`session/request_permission` → `decideGemini`): `execute` → the Bash policy (`decideCodex('command')`; Gemini CLI has no OS sandbox, so `unsandboxedAuto` makes commands keep asking under auto-approve), `edit`/`delete`/`move` → the edit policy with the diff from ACP, `switch_mode` → ExitPlanMode, `fetch` → WebFetch/WebSearch, everything else asks.
- Files inside the working folder are read/written through the client (`fs/read_text_file`, `fs/write_text_file`): the snugcode data folder is denied, writes wait for the checkpoint. Files that don't exist yet are read as empty text (Gemini CLI 0.64 doesn't recognize ENOENT errors over ACP).
- Events: `agent_message_chunk`/`agent_thought_chunk` → text/thinking, `tool_call`/`tool_call_update` → tool cards (shell = Bash, edit = Edit with diff) + results, `plan` → plan card, `usage_update` → context %, the `session/prompt` result → completion summary (tokens & cache). The model per prompt via `session/set_model` (effort suffix dropped), plan mode via `session/set_mode plan`.

### Routers (9router, OmniRoute, LiteLLM, …)
Routers are still supported as regular connections (key + URL). SDK headers are sanitized and the `_ide` suffix is stripped only for router connections. Routers that forward Claude/Antigravity subscriptions (providers `cc/`, `ag/`) are a risk to the user's account (see §1 item 6).

### Virtual Effort Level Slider
- Gemini models split reasoning levels into separate IDs (e.g. `ag/gemini-3.8-flash-low`, `-medium`, `-high`). `snugcode` merges them into **1 model choice with an effort-level slider**.
- Models of non-router connections carry their own effort list (`efforts`): Claude 4.5+/5 on Anthropic connections (`low`–`max`, the Agent SDK `effort` option), GPT on OpenAI/ChatGPT (passed to Codex per turn), Gemini 2.5+/3 (`low`/`medium`/`high`, part of the ID and translated by the proxy into `reasoning_effort`).
- For native Claude models on a router (`cc/claude-opus-5-5`, `cc/claude-sonnet-5-5`, or `claude-*` without a provider), the daemon provides a virtual slider (*auto*, *low*, *medium*, *high*, *max*) mapping virtual IDs (e.g. `cc/claude-opus-5-5-high`) to the real model + the Agent SDK `effort` option. Model/effort switches are applied to the live process (`setModel` / `applyFlagSettings({ effortLevel })`).

### Light Subagent Model
- Non-router connections: a light model from **the same connection** and the same model family (Claude → latest Haiku, Gemini → latest Flash `-low` variant, DeepSeek → `-flash`/`-chat`, GLM → `-air`/`-flash`); OpenAI/ChatGPT (Codex) connections manage their own subagents.
- Old routers: subagents (Explore, Plan, general-purpose) and utility tasks (e.g. WebFetch summaries) use a **light model** picked automatically by `lightModel()` in `shared/models.js`, from only two options:
  - Claude main model (`cc/` or `claude-*` without a provider): **Claude Haiku 5.5** (`cc/claude-haiku-5-5`), then **Gemini 3.8 Flash**.
  - Other main models (`ag/`, `gemini/`, …): **Gemini 3.8 Flash** (`-low` variant, same provider first), then **Claude Haiku 5.5**.
  - Neither on the router: the main model is used.
- Passed via `CLAUDE_CODE_SUBAGENT_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (without `_FORCE`, built-in subagents keep using the main model) and `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Subagent effort is set in `daemon/agents.js` (Explore `low`, the rest `medium`); without it subagents inherit the main model's effort.
- The router's model list is fetched in the background when the daemon starts (5-minute cache, may be stale), so prompts never wait for a `/models` request. The light model for the default model is shown in the PC menu (phone) and `snugcode status`; it can't be changed manually.
- `claude-*` models on other providers (e.g. `ag/claude-opus-4-6-thinking`) **don't** get a virtual slider: their router doesn't know about effort, so the ID is passed as is.

### Step efficiency for non-Claude models
- Every agent step = one model request, so the number of steps determines speed. For non-Claude models (e.g. Gemini), the `PreToolUse` `Read|Grep` hook (`widenToolInput` in `daemon/sessions.js`) widens partial Reads (offset/limit) of files ≤ 2000 lines / 64 KB to the whole file, and Greps without `output_mode` to matching lines + line numbers (`head_limit` 100). Binary files, images, PDFs, notebooks, and the snugcode data folder aren't touched; permissions still go through `canUseTool`. Claude models (including `claude-*` on other providers) aren't widened.
- Other env settings to save tokens: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `BASH_MAX_OUTPUT_LENGTH=15000`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

### Model Checks (Probe)
- Many discontinued (*deprecated*) upstream AI models still return HTTP 200 with an error text payload ("*...is no longer available*").
- The model list is fetched from each connection's `/models` and filtered to models that don't declare `tools: false`.
- When the user picks a model on the phone, `probeRoute` (`daemon/providers.js`) sends one small probe message in that model's route format (Messages, Chat Completions, or Responses; ChatGPT isn't tested) (*stream probe*) and shows "✓ ready · 1.2s" or the reason it failed (including detection of the "no longer available" text). The probe only tests that the model answers, not its *tool calling* ability.

---

## 7. Deep Dive: the `_ide` Issue with Claude Opus 5.5

### The problem
When the user picked Claude Opus 5.5 (`cc/claude-opus-5-5`), the agent failed to run tools and kept repeating the error:
```text
<tool_use_error>Error: No such tool available: Bash_ide</tool_use_error>
```
Even when the model retried with the name it considered correct, the error kept recurring.

### Root Cause
1. **Upstream Claude Code IDE account routing**:
   In 9router, the `cc/*` (Claude Code) prefix is routed to an Anthropic backend integrated with the **Claude Code IDE Extension (VS Code / JetBrains companion)**.
2. **`_ide` suffix injection**:
   In the IDE integration, upstream automatically renames tools declared by the client by appending `_ide` (e.g. `Bash` becomes `Bash_ide`, `Read` becomes `Read_ide`, `Edit` becomes `Edit_ide`), and marks the standard CLI tools as "*This tool is currently unavailable*".
3. **Tool registry mismatch in the SDK**:
   `snugcode` runs `@anthropic-ai/claude-agent-sdk` on the PC in CLI/Agent mode. The SDK registers native tools with the standard names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`. When Claude Opus 5.5's response stream returns the tool name `Bash_ide`, the SDK rejects it because `Bash_ide` isn't registered in the SDK's internal harness.

### Permanent fix via the Loopback Proxy Sanitizer (`daemon/proxy.js`)
`snugcode` has a local loopback proxy on `127.0.0.1` (random port) sitting right between the Claude Agent SDK and 9router. The proxy has a **Tool Name Sanitizer**:
- Removes the `accept-encoding` header so the response stream isn't compressed.
- Rewrites SSE (`text/event-stream`) and JSON responses in streaming fashion **per whole line**: SSE events and JSON always end in a newline, so the tool-name pattern is never split by a TCP chunk boundary. Multi-byte UTF-8 characters split across two chunks are rejoined with `StringDecoder`. Other responses are forwarded as is.
- Strips the `_ide` suffix from tool names (`"name":"Bash_ide"` -> `"name":"Bash"`, `"name":"Read_ide"` -> `"name":"Read"`).
- If the connection to the router drops mid-stream, the connection to the SDK is dropped too so the SDK sees an error and retries (doesn't hang). An unreachable router is answered with a `502` in Anthropic error format. The Stop button also cancels the request to the router.
- The `claude` process only holds the proxy's **random local token** (not the 9router key); the proxy swaps it for the real key. Requests without that token are rejected with 401, so other programs on the PC can't use the user's key, and the agent's Bash can't read the key from env.
- One `claude` process per session is kept alive between prompts (Agent SDK streaming input) and closed after 5 minutes idle (at most 3 idle processes at once; the least recently used is closed first). The process is prepared in the background when the session opens (pre-warm), so the first prompt doesn't wait for spawn + resume. Switching model/effort doesn't create a new process; a new process (with `resume`) is only created when the light model, binary, or URL changes.
- Tested in `test/unit.test.js` by cutting the stream at every position inside `"Bash_ide"` and in the middle of multi-byte characters, and end-to-end with `cc/claude-opus-5-5`.

---

## 8. Other Notable Features

### A. 1-Tap Remote Self-Update from the Phone (`daemon/updater.js`)
- The PC can check for and update its `snugcode` installation remotely.
- Supports two install modes:
  - **Git checkout**: runs `git fetch`, validates the working tree, `git pull --ff-only origin main`, then `npm install --omit=dev --include=optional`.
  - **Global npm**: the `stable` channel (default, `config.updateChannel` / `SNUGCODE_UPDATE_CHANNEL`) installs the latest tagged GitHub release (`github:arfakaisar/snugcode#vX.Y.Z`) when its version is newer than `package.json`; while the repo has no releases, or on the `main` channel, the latest main commit is installed and pinned (`#<sha>`). The installed spec is recorded (`installedSpec`, `installedCommit`), the previous spec in `previousSpec` for **rollback** (`snugcode update --rollback`, RPC `rollback`, a button in the PC Update sheet).
  - **Releases**: `npm version minor && git push --follow-tags` → the Release workflow checks that the tag = the `package.json` version, runs the tests, and creates a GitHub release.
- **Native Claude binary guaranteed** (`daemon/nativebin.js`): the Agent SDK ships `claude.exe` through optional per-platform packages (`@anthropic-ai/claude-agent-sdk-win32-x64`, etc.) that npm can skip without an error. All sessions/daemons are stopped before updating (so files aren't locked on Windows), then the binary's presence is verified after install. Before every prompt, the session also checks the binary and shows a fix command if it's missing. Manual fallback: set `"claudeExecutable": "C:\\path\\to\\claude.exe"` in `~/.snugcode/config.json`.
- **Automatic detection of new pushes**: the daemon checks for new commits every 10 minutes. As soon as one is detected, a dynamic update banner appears at the top of the user's phone screen.
- **Detached restart**: the daemon waits ~1 second so the RPC reply is sent, stops, then an independent (*detached*) helper child process starts a new daemon ~2 seconds later. The phone disconnects for a few seconds then *reconnects* automatically without manual intervention on the PC. On cloud runners (`SNUGCODE_SUPERVISED=1`) the daemon exits with code 75 and the `snugcode cloud` supervisor starts it again.
- **Progress on the phone**: updates from the phone show as *install → restart → reconnected* stages with an estimate of the time left.

### B. Anti-Sleep Service (`daemon/keepawake.js`)
Prevents the PC from going to sleep (*system sleep*) while the daemon runs (starts when the daemon starts, stops when it stops; not used on cloud runners):
- **Windows (win32)**: calls the Windows API `SetThreadExecutionState(0x80000041)` via a background PowerShell. This enables **Away Mode**, letting the monitor/screen turn off to save energy while the CPU and network keep working fully.
- **macOS (darwin)**: runs the built-in `caffeinate -s -w <pid>` utility.
- **Linux**: uses `systemd-inhibit --what=sleep`.

### C. Direct Shell Execution (`!`)
In the chat (on the phone or the PC terminal), messages starting with an exclamation mark (`!`) are executed directly as OS shell commands in the session directory (PowerShell on Windows or bash on macOS/Linux), for example:
```bash
!npm test
!git status
!dir
```
Command output is streamed in real time to the phone screen (max 512 KB, stopped after 10 minutes). For long-running commands (dev servers), use **Run & Preview**. pnpm/yarn that aren't installed are set up automatically through corepack (`daemon/toolchain.js`), also for the agent's Bash and Run processes.

### D. Run & Preview (see your web app from the phone before committing)
- The **▶** button in the session header → **Run**. Setup commands (`npm ci`, `pnpm install`, `yarn install`, `bun install`) and dev commands (`dev`/`start`/`serve`/`preview` scripts; also `python manage.py runserver` and `npx serve` for static sites) are detected automatically, or can be typed manually. They can also be overridden with `.snugcode.json` (or the old `.pocketcode.json`) in the repo root: `{ "setup": "…", "dev": "…" }`.
- The process runs in the background without blocking the agent. The `PORT` env var is set to a free port, and `{port}` in the command is replaced with the same port. The port is detected from the logs.
- **Preview on the phone**: a Cloudflare quick tunnel to a local gate on `127.0.0.1`. The link contains a secret token (sent only over the E2EE channel), which is then exchanged for an HttpOnly cookie. Without the token, the link is rejected with 401. Host/Origin are rewritten to `localhost` so Vite/Next HMR works. The tunnel closes when the process stops.
- **Screenshots** of the page from the phone (headless Chrome/Edge on the PC) with console errors. One tap forwards the errors to the agent.
- The agent uses the same tools (`dev_start`, `preview_screenshot`, …) to verify its own UI.
- **.env template**: session menu → *Save .env as template*. That file is restored automatically in new worktrees of the same repo.
- Requirements: `cloudflared` (downloaded automatically to `~/.snugcode/bin`, or set `cloudflaredExecutable` in the config) and Chrome/Edge/Chromium for screenshots (`browserExecutable` in the config if not detected).

### E. Collaborating with the agent
- **Send images** from the camera/gallery/clipboard (compressed on the phone, max 4 per message).
- **The agent asks** (`AskUserQuestion`): tap options on the phone, numbered choices in the terminal. Always waits for the user, even under auto-approve.
- **Plan mode** (**+** button → *Plan mode* / `/plan`): the agent only reads, then proposes a plan. *Approve & build* turns off plan mode and the agent starts working.
- **Checkpoints & rewind**: every prompt stores a worktree snapshot (including uncommitted changes; `node_modules` excluded). The ↺ button on a prompt or `/rewind` restores all files.
- **Web Push**: turn on from the menu → *Allow notifications*. Notifications appear when the agent finishes, needs permission, or asks a question, even when the PWA is closed (iOS: add it to the Home Screen first).

### F. File explorer, diff review & terminal from the phone
- **Files** (session menu): browse the worktree (`files`), read text/images (`fileRead`; >400 KB only over the binary channel), edit & create files (`fileWrite` with a hash: files that changed on the PC are rejected). The agent is told on the next prompt that the user changed files (`userChanged` → `meta.note`). *Ask the agent* fills the composer with the file path.
- **Diff review** (Git screen): the diff is parsed per file/hunk; comments per line or hunk are collected and then *Send to agent* as one message containing the quoted code. *Revert hunk/file* (`revert`, rejected while the agent is running): `git apply -R` for one hunk, `git checkout HEAD --` for one file, new files are deleted.
- **Terminal** (session menu): a PTY on the PC (`termOpen`/`termAttach`/`termIn`/`termResize`/`termClose`, `term` event), xterm.js loaded when first opened, a key row Esc/Tab/Ctrl/Alt/arrows/Paste/Copy/^C/Home/End, xterm assets prefetched while idle when a session opens, input batched every 8 ms. On touch screens, phone keyboard typing (IME composition) is sent directly as a diff of the xterm textarea contents (`imeDelta`) instead of waiting for the word to be committed; a two-finger pinch changes the font size. The shell stays alive when the screen is closed or the connection drops (the latest output is replayed); a live terminal keeps a cloud runner from being considered idle. Needs the optional `@lydell/node-pty` package.

### G. OS keychain for `secrets.json`
- `snugcode keychain on|off|status`. When on, `secrets.json` contains `{ snugcodeKeychain: 1, kc, n, c }` (XChaCha20-Poly1305, AAD `snugcode-secrets-v1`); the 256-bit key only exists in the OS keychain, one item per data folder. The file mode is preserved when rewriting. If the key can't be opened, the daemon stops with a clear message (it never overwrites with empty secrets). `secrets.key` (DPAPI) is also protected from the agent.

---

## 9. Configuration Guide & CLI Commands

### Prerequisites
- **Node.js 22+**
- **Git**
- A **ChatGPT account** or any **model API key** (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Kimi, GLM, xAI, Groq, or a router such as 9router/OmniRoute)
- A **GitHub** account

### Install & Setup on the PC
```bash
# Install globally
npm i -g github:arfakaisar/snugcode

# Run the interactive setup wizard
snugcode setup

# Enable the background service & run it when the PC boots
snugcode autostart on
```

### Full CLI Command List

| Command | Description |
|---|---|
| `snugcode` / `snug` | Opens the interactive Terminal UI in the current directory. |
| `snugcode "prompt"` | Opens the TUI and sends an initial prompt right away. |
| `snugcode --pick` | Opens the active session picker (including sessions created from the phone). |
| `snugcode --computer` / `-c` | Opens the TUI with a Computer mode session in the current directory. |
| `snugcode setup` | Re-runs the configuration guide (API key, model, GitHub, PIN). |
| `snugcode login` | Signs in to GitHub again only (token revoked/expired); takes effect without a restart if the daemon is running. |
| `snugcode connect <key> [--url URL]` | Connects a model API key; type & format detected automatically (through the daemon if running). |
| `snugcode connect chatgpt` | ChatGPT sign-in through Codex (the daemon must be running); the code can be completed on the phone. |
| `snugcode connect` / `snugcode disconnect <id>` | Lists model connections / removes one connection. |
| `snugcode start` | Runs the daemon in the foreground of this terminal. |
| `snugcode stop` | Stops the daemon running in the background. |
| `snugcode restart` | Restarts the background daemon. |
| `snugcode update` | Checks for and installs the latest snugcode update from GitHub. |
| `snugcode autostart on\|off` | Enables/disables auto-starting the daemon at OS login. |
| `snugcode clean` | Scans & removes orphaned worktrees, repos, and logs (aborted if `sessions/index.json` can't be read). |
| `snugcode pin` | Changes the pairing PIN and unlocks the lockout right away (restart the daemon for it to take effect). |
| `snugcode update --rollback` | Goes back to the version before the last update (npm installs). `--channel stable\|main` switches the update channel. |
| `snugcode devices` | Lists the phones currently paired. |
| `snugcode revoke <id\|all>` | Revokes access of a specific phone or all phones (restart the daemon for it to take effect). |
| `snugcode status` | Shows a configuration summary: runtime, relay, account, model & light model, GitHub sign-in, number of phones, PIN lock status, keychain. |
| `snugcode keychain on\|off\|status` | Encrypts `secrets.json` with a key in the OS keychain / turns it back into plain text / status (see §8.G). |
| `snugcode cloud` | Cloud runner: configuration from env (`daemon/runner.js`), daemon under a supervisor (`--no-supervise` to run it directly). |
| `snugcode help` | List of commands. |

Non-interactive `setup` flags: `--router`, `--key`, `--model`, `--github device|cred|pat|skip`, `--github-token <token>`, `--skip-github`, `--relay`, `--name`, `--pin`, `--relink`, `--no-browser`.

### Local Data Storage Layout (`~/.snugcode/`)
- The location can be changed with `SNUGCODE_HOME`; older installs that already have `~/.pocketcode` keep using that folder. Codespaces runners: `/workspaces/.snugcode`; Docker: `/data`.
- `config.json`: general configuration (machine name, ID, relay URL, router URL, default model, `runtime`, `runner`, `installedCommit`).
- `secrets.json`: local credentials (machine relay token, GitHub token, PIN PRS, device secrets & push subscriptions of paired phones, local IPC token, runner Codespaces token). File permissions restricted (mode 600 on UNIX). Written atomically (tmp + rename).
- `daemon.log`, `daemon.pid`, `daemon.sock`: log, process ID, and the IPC unix socket for the TUI (Windows: named pipe `\\.\pipe\pocketcode-<hash>`). Cloud runners: `cloud.log` & `install.log`.
- `workspaces/<owner>__<repo>/`: the base clone (`_base`, kept 3 days after the last session is deleted) and one git worktree directory per coding session (`s-<id>`).
- `sessions/`: `index.json` (session list; if corrupted it is saved as `index.json.broken-*` and sessions are recovered from the worktrees) and the per-session JSONL event history (`<sessionId>.jsonl`).
- `env/`: `.env` templates per repo. `bin/`: `cloudflared` and pnpm/yarn shims (`bin/pm`). `tools/`: corepack, `codex/`, `gemini/` (installed when first needed).
- `codex/`, `gemini/`: snugcode's own `CODEX_HOME` and `GEMINI_CLI_HOME`. `secrets.key`: DPAPI key (Windows, `keychain on`). `runner-usage.json`: estimated Codespaces runner core-hours.
- `claude/`: Agent SDK configuration directory (`CLAUDE_CONFIG_DIR`, including `plans/`), separate from the user's own Claude Code install.

---

## 10. Development Status & Future Roadmap

- [x] End-to-end encryption with CPace (Ristretto255) & XChaCha20-Poly1305.
- [x] Remote self-update & automatic 1-tap push detection from the phone.
- [x] Anti-sleep system (Windows Away Mode, macOS caffeinate, Linux systemd-inhibit).
- [x] Support for Claude Opus 5.5, Sonnet 5.5 & Gemini via 9router.
- [x] Automatic normalization of the `_ide` tool-name suffix via the local loopback proxy.
- [x] Git worktree isolation & stale lock cleanup.
- [x] Write/Edit permission prompts with mini-diffs; stricter push/`gh` detection.
- [x] GitHub Actions CI (unit tests + web build on Linux/Windows/macOS).
- [x] Run & Preview: background dev servers + token-protected tunnel to the phone + screenshots.
- [x] Agent MCP tools to run and see its own UI.
- [x] Web Push notifications when the PWA is closed in the background.
- [x] Send images / screenshots to the agent from the phone's camera/gallery.
- [x] AskUserQuestion, plan mode, per-prompt checkpoints & rewind.
- [x] Cloud runner without a PC: GitHub Codespaces (created & started from the phone) and Docker; machine settings (models & API keys, PIN, devices) from the phone.
- [x] Computer mode (sessions with access to the whole PC) on the phone and terminal.
- [x] Read/Grep widening hook for non-Claude models (±3× fewer model requests).
- [x] Runner stage reports, progress bars with time-left estimates, removing machines from the list, reconnecting Codespaces permission.
- [x] Deploy workflow (relay + PWA from GitHub Actions).
- [x] Multi-provider connections: ChatGPT sign-in (Codex) & any API key with automatic detection; engine per model (Claude Agent SDK / Codex), OpenAI format translator, OS sandbox for Codex.
- [x] Gemini CLI engine (ACP) for Gemini models, and a per-model harness benchmark (`npm run bench` → `shared/engine-table.js`).
- [x] Hardening: OS sandbox for Claude engine auto-approve, project settings not loaded, repo configuration protected, relay tokens separated by kind & revocable, PC linking confirmation, PWA CSP, rate limiting, time-limited PIN locks.
- [x] Tagged releases (stable channel) + rollback; "runner stopped" push notifications.
- [x] Codespaces quota estimate (core-hours tracked by the runner) and codespace prebuilds (`onCreateCommand`, guide in `.devcontainer/README.md`).
- [x] OS keychain integration (macOS Keychain / Secret Service / DPAPI) for `secrets.json`.
- [x] Full interactive PTY terminal on the phone.
- [x] Lightweight file explorer/editor and per-hunk diff review with comments to the agent.
- [x] Unbypassable PC linking, narrow CSP `connect-src`, WebSocket token via subprotocol, sign-in renewal, verified cloudflared, deploy after CI + verified builds, docs/security.md.
- [x] Heartbeat & RPC timeouts, risk-graded permission cards, autonomy presets, session cost & cost limits, permissions from notifications, one-line installer, WCAG AA contrast.
- [x] Landing page at snugcode.dev, app (snugcode agent) at snugcode.dev/agent/, English UI & docs.
- [ ] E2EE preview tunnel through our own relay. Postponed: the preview must be on an origin separate from the PWA (same-origin preview code could read tokens & device secrets in the PWA's storage), and a Service Worker can't forward HMR WebSockets.
- [ ] Amazon Bedrock & Google Vertex AI (the proxy needs SigV4 signing / service OAuth tokens).
