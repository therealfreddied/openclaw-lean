#!/usr/bin/env node
/**
 * Northflank launcher for the OpenClaw gateway.
 *
 * Responsibilities (boot order):
 *   1. Generate ~/.openclaw/openclaw.json from env vars (disk is ephemeral).
 *   2. Restore the state snapshot from remote storage if configured.
 *   3. Spawn `node openclaw.mjs gateway --port $PORT --bind lan` with tuned
 *      V8 heap flags, forwarding signals.
 *   4. On SIGTERM/SIGINT/child exit: push a final state snapshot, then exit.
 *
 * Required env: GATEWAY_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOW_FROM.
 * Optional env: STATE_REMOTE (turso|s3), TURSO_DATABASE_URL, TURSO_AUTH_TOKEN,
 *   S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT,
 *   STATE_SYNC_INTERVAL_SECONDS, MAX_OLD_SPACE_MB, MAX_SEMI_SPACE_MB, PORT.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(repoRoot, ".openclaw-state");
const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
const port = Number(process.env.PORT ?? 18789);
const syncIntervalSec = Number(process.env.STATE_SYNC_INTERVAL_SECONDS ?? 900);
const stateRemote = process.env.STATE_REMOTE ?? "";

function log(msg) {
  process.stdout.write(`[launcher] ${new Date().toISOString()} ${msg}\n`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    log(`FATAL: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

function csvList(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildConfig() {
  const token = requireEnv("GATEWAY_TOKEN");
  const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const allowFrom = csvList(process.env.TELEGRAM_ALLOW_FROM).map(Number);
  const hooksEnabled = process.env.HOOKS_ENABLED !== "0";
  const hooksToken = process.env.HOOKS_TOKEN ?? token;
  const allowedAgentIds = csvList(process.env.HOOKS_ALLOWED_AGENT_IDS ?? "main");
  const users = csvList(process.env.TELEGRAM_USERS);

  const config = {
    gateway: { mode: "local", auth: { mode: "token", token } },
    channels: { telegram: { botToken, enabled: true } },
    hooks: {
      enabled: hooksEnabled,
      token: hooksToken,
      path: "/hooks",
      allowedAgentIds,
      allowRequestSessionKey: false,
    },
    agents: {
      defaults: {
        heartbeat: { every: process.env.HEARTBEAT_EVERY ?? "30m" },
      },
    },
  };
  if (allowFrom.length > 0) config.channels.telegram.allowFrom = allowFrom;
  if (users.length > 0) config.agents.defaults.user = users.join(",");
  return config;
}

async function writeConfig() {
  await mkdir(stateDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(buildConfig(), null, 2));
  log(`config written to ${configPath}`);
}

async function restoreState() {
  if (!stateRemote) {
    log("STATE_REMOTE not set; starting with empty state");
    return;
  }
  const { restoreSnapshot } = await import("./state-sync.mjs");
  try {
    await restoreSnapshot({ stateDir, remote: stateRemote });
    log("state snapshot restored");
  } catch (error) {
    log(`state restore failed (continuing with empty state): ${error?.message ?? error}`);
  }
}

async function pushState(reason) {
  if (!stateRemote) return;
  const { pushSnapshot } = await import("./state-sync.mjs");
  try {
    await pushSnapshot({ stateDir, remote: stateRemote });
    log(`state snapshot pushed (${reason})`);
  } catch (error) {
    log(`state push failed (${reason}): ${error?.message ?? error}`);
  }
}

function childEnv() {
  const env = { ...process.env };
  const oldSpace = process.env.MAX_OLD_SPACE_MB ?? "180";
  const semiSpace = process.env.MAX_SEMI_SPACE_MB ?? "8";
  const v8Flags = `--max-old-space-size=${oldSpace} --max-semi-space-size=${semiSpace}`;
  env.NODE_OPTIONS = env.NODE_OPTIONS
    ? `${env.NODE_OPTIONS} ${v8Flags}`
    : v8Flags;
  env.OPENCLAW_STATE_DIR = stateDir;
  env.OPENCLAW_CONFIG_PATH = configPath;
  return env;
}

function startGateway() {
  const child = spawn(
    process.execPath,
    ["openclaw.mjs", "gateway", "--port", String(port), "--bind", "lan"],
    { cwd: repoRoot, env: childEnv(), stdio: "inherit" },
  );
  log(`gateway spawned (pid ${child.pid}, port ${port}, bind lan)`);
  return child;
}

let shuttingDown = false;
let child;

async function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  if (child && child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 8000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await pushState(reason);
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("unhandledRejection", (error) => {
  log(`unhandledRejection: ${error?.message ?? error}`);
});
process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${error?.message ?? error}`);
  void shutdown("uncaughtException", 1);
});

await writeConfig();
await restoreState();

const syncTimer = setInterval(
  () => void pushState("interval"),
  Math.max(60, syncIntervalSec) * 1000,
);
syncTimer.unref();

function onChildExit(code, signal) {
  if (shuttingDown) return;
  log(`gateway exited (code=${code}, signal=${signal}); restarting in 5s`);
  setTimeout(() => {
    child = startGateway();
    child.on("exit", onChildExit);
  }, 5000);
}

child = startGateway();
child.on("exit", onChildExit);
