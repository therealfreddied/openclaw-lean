# OpenClaw Lean Kit

Deploy OpenClaw on small hosts (512MB–1GB RAM, tiny disk) with **zero
functional or protocol changes**. This kit never modifies OpenClaw's code,
schemas, or wire protocol — compatibility with vanilla is inherited by
construction.

## Compatibility contract (READ BEFORE TOUCHING ANYTHING)

A lean deployment MUST remain indistinguishable from vanilla on these
surfaces. Vanilla clients ↔ lean gateway and lean clients ↔ vanilla gateway
must both work with no flags or workarounds.

| Surface | Guarantee | How the kit preserves it |
| --- | --- | --- |
| Gateway WebSocket protocol + token auth | untouched | we run the unmodified upstream `openclaw` package |
| Control UI served by the gateway | untouched | `dist/` runtime code and UI assets are never modified |
| HTTP hooks (`POST /hooks/wake`, `/hooks/agent`) | untouched | same binary; `Authorization: Bearer` / `X-OpenClaw-Token` semantics upstream |
| SQLite state schema | untouched | state dir is byte-portable between vanilla and lean installs |
| Config schema (`openclaw.json`) | untouched | generated config validates against upstream zod schema |
| CLI contract | untouched | launcher execs upstream `openclaw.mjs gateway` with documented flags only |
| Plugin manifests / lazy loading | untouched | no registry or loader changes |

**Never do** in this kit or any fork of it: patch `dist/`, bundle or
tree-shake `node_modules` code at runtime, alter message shapes, add
compatibility readers for config/state. If a future optimization would touch
any row above, stop and re-read the contract.

## What the kit changes (the only allowed levers)

1. **Runtime binary**: sideload official Node 24 via the npm `node` package
   (or Bun ≥ 1.4, also upstream-supported) when the host image is too old.
2. **V8 heap flags** via `NODE_OPTIONS` (`--max-old-space-size`,
   `--max-semi-space-size`). Never `--gc-interval` (stress flag).
3. **Env**: `NODE_ENV=production`, `NODE_COMPILE_CACHE` for faster restarts.
4. **Disk pruning** (`prune.mjs`): delete files the runtime never reads
   (sourcemaps, type declarations, docs, test fixtures). Protocol-inert.
   Tested against a synthetic fixture: removes `*.map`/`*.d.ts`/`.tsbuildinfo`
   (including inside `dist/`), `docs/`, `tests/`, `examples/`, `fixtures/`,
   `CHANGELOG*`, `README*`-adjacent metadata; refuses to run without an
   `openclaw` dependency in the root `package.json`; never touches `state/`,
   `.env`, `package.json`, plugin manifests, UI/public/assets, `bin/`, or the
   upstream launcher `.mjs` files. Dry-run by default; `--apply` to delete.

## Files

- `deploy/package.json` — deps (`node` + `openclaw`) and the required
  `scripts.start` (Pterodactyl-style eggs run `npm start`; without it npm
  fails with `imaginaryUncacheableRequireResolveScript`).
- `deploy/index.js` — launcher: loads `.env`, generates a schema-valid
  `state/openclaw.json`, spawns Node 24 + gateway with heap caps, tees all
  output to `gateway.log`, samples parent/child RSS every 60s.
- `deploy/env.example` — secrets template.
- `prune.mjs` — on-host disk pruner (dry-run default; `--apply` to delete).

## Deploy on a Pterodactyl-style bot host

1. Upload `deploy/package.json`, `deploy/index.js`; create `.env` from
   `env.example`.
2. Startup → set **JS_FILE** to `index.js` (or set the whole startup command
   to `npm install --no-audit --no-fund; node index.js`).
3. Optional disk prune: append `node prune.mjs --apply` before `node
   index.js` (upload `prune.mjs` too).
4. Start. Watch `gateway.log` (readable over SFTP even when the panel
   console is broken).

## Memory targets

| Host plan | `MAX_OLD_SPACE_MB` | Expected idle RSS |
| --- | --- | --- |
| 512MB | 320 | measure — see launcher's 60s RSS lines in `gateway.log` |
| 1GB | 640 | measure |

The RSS sampler exists so targets are set from data, not vibes. Do not ship
RAM claims without 24h of `gateway.log` evidence.
