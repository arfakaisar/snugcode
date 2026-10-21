# snugcode runner

This codespace runs the **snugcode daemon** — a Claude Code agent you control from the snugcode
app on your phone. You don't need to do anything here.

- Runner log: `/workspaces/.snugcode/cloud.log`; install log: `install.log` in the same folder
  (if `/workspaces` isn't writable, the data folder moves to `~/.snugcode`).
- Stages and errors while the runner starts are also sent to the app, so you usually don't need the logs.
- Status: `snugcode status`
- A daemon that dies is restarted by the supervisor; SIGTERM to the supervisor is ignored (`pkill node` doesn't kill
  the runner). To stop it: `snugcode stop`. If the runner still won't connect, the app restarts
  this codespace once automatically.
- The runner stops itself after 30 idle minutes (configurable in the app: Runner settings →
  Auto stop), and starts again when you open the "Cloud" runner in the app.
- The repos the agent works on live in `/workspaces/.snugcode/workspaces/`, one worktree per session.
- Don't delete this codespace from GitHub while it's still in use; to stop using the runner, remove it from
  the app (machine list → ⋯ → Remove) so the codespace, secret, and machine are removed too.

## Prebuild (optional): faster new runners

Without a prebuild, creating a runner takes ~3–5 minutes (installing Chromium, bubblewrap, and snugcode). With a prebuild,
all of that is already in the snapshot and the runner starts in ~1 minute. Prebuilds are configured in your **fork**'s
repo settings (GitHub has no API for this):

1. Open your snugcode fork → **Settings → Codespaces → Set up prebuild**.
2. Branch `main`, configuration `.devcontainer/devcontainer.json`, the same region as your codespace.
3. Trigger: **On configuration change** (the prebuild is only rebuilt when `.devcontainer/` changes; snugcode
   updates itself after starting).

Prebuild snapshots use Codespaces storage quota (15 GB-month free on Free accounts), and every build
uses Actions core-hours. This month's runner core-hour usage (estimate) is shown in the app: runner menu →
Cloud runner.
