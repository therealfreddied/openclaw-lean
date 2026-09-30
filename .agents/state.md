# State

Status: OpenClaw Lean repository thinned (140MB) and published to GitHub

## Goal

Solid, heavily-optimized OpenClaw under 512MB RAM on cheap/free hosts, 24/7,
with 100% protocol and feature compatibility with vanilla OpenClaw.

## Today's progress

- **GitHub Authentication:** Authenticated GitHub CLI (`gh`) and Git with PAT for account `therealfreddied`.
- **Deep Repo Code-Size Thinning:** Reduced tracked git tree from **616 MB (50,646 files) → 140 MB (25,058 files)**:
  - Untracked all unit/e2e test suites (`src`, `ui`, `packages`, `extensions`, `scripts`).
  - Untracked native mobile/desktop apps (`/apps/android`, `/apps/ios`, `/apps/macos`).
  - Untracked `/docs`, `/crates`, `/qa`, `/CHANGELOG/`, `.github/` workflows.
  - Untracked non-English UI translation memory files (`en` kept).
  - Preserved 100% of Gateway runtime code, Control UI source, packages, and Telegram/Discord/Slack channels.
- **GitHub Publication:** Created public repo and pushed clean release commit to `https://github.com/therealfreddied/openclaw-lean`.
- **Lean Deploy Kit:** `lean/deploy/index.js` upgraded with cgroup memory limit auto-detection (65% heap cap), `UV_THREADPOOL_SIZE=2`, `NODE_COMPILE_CACHE`, and 60s RSS sampler; built `lean/thin.mjs` on-host disk pruner.

## Blockers

None.

## Next actions

1. Deploy `https://github.com/therealfreddied/openclaw-lean` on SkailarHost, WispByte, or any 512MB VPS.
2. Monitor RSS in `gateway.log` over SFTP to verify memory footprint under 320 MB.
