# OpenClaw on Northflank (free tier, no Docker)

Hyper-optimized OpenClaw gateway deploy: 256MB RAM, 0.1 vCPU, ephemeral disk,
buildpack build. Full functionality retained — the Dockerfile in this repo is
NOT used; Northflank's buildpack path is chosen explicitly.

## How it works

- `Procfile` → `node northflank/start-gateway.mjs`
- Launcher boot order: generate `openclaw.json` from env → restore state
  snapshot (optional) → spawn gateway with V8 memory flags → sync state on
  SIGTERM and every `STATE_SYNC_INTERVAL_SECONDS`.
- Gateway listens on `$PORT` (Northflank injects it), bound to `0.0.0.0`
  (`--bind lan`).
- Restart-on-crash with 5s backoff is built into the launcher.

## Deploy steps

1. Push this repo to your own GitHub account (upstream openclaw/openclaw
   does not accept pushes).
2. Northflank → Create service → **Deploy from Git** → pick your repo/branch.
3. Build type: **Buildpack** (explicitly NOT Dockerfile — the repo contains
   one and Northflank would otherwise auto-detect it).
4. Add a TCP/HTTP port mapped to `$PORT`; enable public ingress if you want
   webhooks to reach the gateway.
5. Set env vars (table below), deploy.
6. After first successful deploy, point external cron at
   `POST https://<your-service>.nf.run/hooks/wake` — see "Heartbeat" below.

## Environment variables

### Required

| Variable | Example | Purpose |
| --- | --- | --- |
| `GATEWAY_TOKEN` | long random string | Gateway auth token (`gateway.auth.token`) |
| `TELEGRAM_BOT_TOKEN` | `123456:ABC-...` | Telegram bot token (`channels.telegram.botToken`) |
| `TELEGRAM_ALLOW_FROM` | `11111111,22222222` | Human sender Telegram user IDs (CSV). Access control — do not skip. |

### Optional — state persistence

Without these, state (sessions, cron jobs, heartbeat monitors) is lost on
every restart/redeploy. With them, the launcher gzips the state dir into one
remote object at boot/SIGTERM/interval.

| Variable | Example | Purpose |
| --- | --- | --- |
| `STATE_REMOTE` | `turso` or `s3` | Backend selection |
| `TURSO_DATABASE_URL` | `libsql://mydb.turso.io` | Turso DB URL |
| `TURSO_AUTH_TOKEN` | token | Turso auth |
| `S3_BUCKET` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | S3 backend (SigV4, pure Node) |
| `S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | R2/MinIO/custom endpoint |
| `STATE_SYNC_INTERVAL_SECONDS` | `900` | Periodic push cadence (min 60) |

### Optional — tuning

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_OLD_SPACE_MB` | `180` | V8 old-space cap for the gateway child |
| `MAX_SEMI_SPACE_MB` | `8` | V8 semi-space cap |
| `HEARTBEAT_EVERY` | `30m` | Heartbeat cadence (cron monitor job) |
| `HOOKS_ENABLED` | `1` | Set `0` to disable webhook ingress |
| `HOOKS_TOKEN` | falls back to `GATEWAY_TOKEN` | Webhook bearer token |
| `HOOKS_ALLOWED_AGENT_IDS` | `main` | CSV of agents reachable via webhooks |
| `PORT` | injected by Northflank | Gateway port (fallback 18789) |

## RAM tuning notes

- Old space 180MB + semi-space 8MB keeps V8 under the 256MB service limit
  while leaving headroom for the OS and RSS overshoot. If you see OOM kills,
  lower `MAX_OLD_SPACE_MB` to 150; if you see spurious GC churn, raise it.
- Channel plugins load lazily; only Telegram is configured by default, so
  only its module is ever imported.
- Do NOT add `--gc-interval` (it is a GC stress flag, not a tuning flag).

## Heartbeat and external cron

The gateway's heartbeat runs as an internal cron monitor job (default every
30m) and survives restarts once state persistence is configured. To wake the
agent from outside (e.g. Northflank cron job or UptimeRobot):

```
POST https://<service>.nf.run/hooks/wake
Authorization: Bearer <HOOKS_TOKEN>
Content-Type: application/json

{"mode": "now"}
```

The token must be in the `Authorization: Bearer` header or
`X-OpenClaw-Token` header — `?token=` query params are rejected.

## Turso setup (recommended free backend)

```bash
turso db create openclaw-state
turso db show openclaw-state --url      # TURSO_DATABASE_URL
turso db tokens create openclaw-state   # TURSO_AUTH_TOKEN
```

The snapshot is stored as a single HTTP blob; no tables or schema needed.

## Security notes

- `GATEWAY_TOKEN` gates the gateway API; `HOOKS_TOKEN` gates webhooks.
- Webhook sessions are fixed to the listed `HOOKS_ALLOWED_AGENT_IDS`;
  `allowRequestSessionKey` stays `false` so callers cannot address arbitrary
  sessions.
- Keep `TELEGRAM_ALLOW_FROM` restricted to your own Telegram user ID.
- Never commit real tokens; set them as Northflank env vars (they are
  write-only in the UI).

## Troubleshooting

- **Service restarts every ~5 min**: OOM. Lower `MAX_OLD_SPACE_MB`.
- **Webhook returns 401**: token mismatch — header must be
  `Authorization: Bearer <HOOKS_TOKEN>`.
- **Telegram silent**: check `TELEGRAM_ALLOW_FROM` matches your numeric user
  ID (from @userinfobot), and the bot token is valid.
- **State lost after deploy**: `STATE_REMOTE` unset, or remote snapshot stamp
  older than local marker (check logs for `state-sync` lines).
- **Build fails on Node version**: this repo needs Node `>=24.16.0 <25` or
  `>=26.1.0` (see `package.json` engines). The buildpack picks this up from
  `engines`.
