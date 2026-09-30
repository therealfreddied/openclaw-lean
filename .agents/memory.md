# Memory — hyper-optimized OpenClaw fork (Northflank deploy)

## Project

Fork of openclaw/openclaw (v2026.9.6) optimized for Northflank free tier:
256MB RAM, 0.1 vCPU, ephemeral disk, buildpack deploy (NO Dockerfile use).
Full functionality retained — optimize, do not remove.

## Goal

24/7 OpenClaw gateway on Northflank: user pushes this repo to their GitHub,
deploys via "Deploy from Git" with buildpack explicitly chosen (repo contains
a Dockerfile that would otherwise be auto-detected), root Procfile runs
`node northflank/start-gateway.mjs`.

## Decisions

- PIVOT (2026-09-29): goal is no longer Northflank-specific. Target = solid
  OpenClaw under 512MB RAM, works on any cheap/free host (SkailarHost 1GB paid
  is the live deploy; WispByte 512MB free is fallback), 24/7.
- Northflank dead end: free tier requires payment method to CREATE resources
  (verified via their docs + live attempt). Project shell free, services gated.
- Deploy pattern that works on Pterodactyl-style bot hosts: package.json with
  deps {"node":"24.21.0","openclaw":"2026.9.6"} + scripts.start + index.js
  launcher (loads .env, writes state/openclaw.json, spawns node_modules/node/
  bin/node openclaw.mjs gateway --port $PORT --bind lan). Egg runs npm install
  + npm start. MUST have scripts.start or npm errors
  imaginaryUncacheableRequireResolveScript.
- Host node 22.23.0 too old for openclaw engines (>=24.16 <25 || >=26.1) —
  sideload Node 24 via npm `node` package (ships official binaries).
- index.js launcher: logs to gateway.log (console unreliable), tees child
  output, RSS sampler every 60s (parent + /proc/<pid>/status of child).
- SFTP-only management works: shell/exec requests are refused by host SSH
  (file ops only). Can upload files + ls + read logs remotely.

## 2026-09-29 — Deep Repo Thinning, Git Authentication & GitHub Release

- **Blobless clone push gotcha:** pushing a blobless shallow clone to a new empty GitHub repo fails with `remote unpack failed: did not receive expected object` due to missing historical blobs. Resolution: checkout a clean orphan branch (`git checkout --orphan main-clean`) to create a single 140MB root commit of the current HEAD.
- **Repository code-size optimization:** untracking non-runtime trees (test suites, native client apps under `/apps/`, `/docs/`, `/crates/`, `/qa/`, non-English translation memory packs) reduced the tracked repository size from 616 MB (50,646 files) down to 140 MB (25,058 files). Zero Gateway runtime code, Control UI source, or channel extensions (Telegram/Discord/Slack) were removed.
- **GitHub CLI Non-Interactive Auth:** `gh auth login --with-token` + `gh auth setup-git` configures `gh` as git credential helper cleanly.
- **GitHub Release:** Published to `https://github.com/therealfreddied/openclaw-lean` (branch `main`).
- **Dynamic Cgroup Heap Auto-Tuning:** `lean/deploy/index.js` reads `/sys/fs/cgroup/memory.max` (v2) or `/sys/fs/cgroup/memory/memory.limit_in_bytes` (v1) and sets `--max-old-space-size` to 65% of container RAM limit (e.g. 320MB on a 512MB box).

- Keep full checkout (sparse disabled) at end so all blobs are local for push.

## Gotchas

- Termux device: ~1GB free RAM. NEVER run pnpm install, full tsc, vitest run,
  gradle, docker, rm -rf, dev servers. Use rg / Grep tool only (no grep -r).
- Bash tool default workdir is ~/openclaw; bare commands fail if dir missing.
- Repo is a sparse blobless clone (depth 1, filter=blob:none). Reading a file
  outside sparse-checkout requires `git show HEAD:<path>`, not Read tool.
- `src/auto-reply/heartbeat.ts` not in worktree — DEFAULT_HEARTBEAT_EVERY="30m"
  via git show. Heartbeat = system-owned cron monitor jobs
  (src/cron/heartbeat-monitor.ts).
- Webhook token must be sent as `Authorization: Bearer <token>` or
  `X-OpenClaw-Token` header — query param `?token=` is explicitly rejected
  (src/gateway/server/hooks-request-handler.ts:239-243).
- Telegram config: `channels.telegram.botToken`, `allowFrom` = human sender
  numeric user IDs, multi-account via `channels.telegram.accounts`.
- Node engines: `>=24.16.0 <25 || >=26.1.0`; packageManager pnpm@12.5.1.
- Northflank free tier: 2 services, 2 cron jobs, 1 free DB; buildpack builds
  run on separate builders (build RAM ≠ runtime 256MB).
- Gateway default port 18789; `--bind lan` → 0.0.0.0 (net.ts ~:266).

## Environment

- Device: Android/Termux, 6.4GB free of 104G. Repo at ~/openclaw, 366MB
  (sparse). Local node v24.18.0 satisfies engines.
- Upstream remote = openclaw/openclaw (cannot push). User creates own GitHub
  repo; push is user's step.
