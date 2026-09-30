# State

Status: lean repo thinned (616MB -> 140MB) + lean deploy kit ready

## Goal

Solid, heavily-optimized OpenClaw under 512MB RAM on cheap/free hosts, 24/7,
with 100% protocol and feature compatibility with vanilla OpenClaw.

## Today's progress

- Mapped full npm package bloat via unpkg metadata (297MB mapped: worker 101MB, control-ui 51MB, .d.ts 17MB, docs 15MB).
- Deep repo code-size thinning for fast GitHub push on slow connections:
  - Tracked tree reduced from **616MB (50,646 files) -> 140MB (19,273 files)**.
  - Dropped all test/spec suites (src, ui, packages, extensions, scripts).
  - Dropped native client apps (/apps/android, /apps/ios, /apps/macos).
  - Dropped /docs, /crates, /qa, /CHANGELOG archive, .github CI workflows.
  - Dropped non-English translation memory packs.
  - Kept 100% of Gateway server runtime code, Control UI source, packages, and core channel extensions (Telegram, Discord, Slack).
- Built `lean/thin.mjs` on-host thinner tool for small-disk VPS/hosts.
- Upgraded `lean/deploy/index.js` with cgroup-aware auto heap sizing (65% of container RAM limit), `UV_THREADPOOL_SIZE=2`, `NODE_COMPILE_CACHE`, and 60s RSS sampler.

## Next actions

1. Push thinned repo to user's GitHub repo.
2. For SkailarHost/Wispbyte: upload `lean/deploy/` files, run `npm install`, and start.
3. Monitor RSS in `gateway.log` to confirm idle footprint under 320MB.
