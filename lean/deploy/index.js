const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const NODE24 = path.join(ROOT, "node_modules", "node", "bin", "node");
const OPENCLAW = path.join(ROOT, "node_modules", "openclaw", "openclaw.mjs");
const STATE = path.join(ROOT, "state");

// tiny .env loader (panel may not allow custom env vars)
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const LOG = path.join(ROOT, "gateway.log");
const logStream = fs.createWriteStream(LOG, { flags: "a" });
function trace(msg) {
  const line = `[launcher ${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + "\n");
  logStream.write(line + "\n");
}

fs.mkdirSync(STATE, { recursive: true });
trace("launcher started, node " + process.version);
const config = {
  gateway: { mode: "local", auth: { mode: "token", token: process.env.GATEWAY_TOKEN || "set-a-long-random-token" } },
  channels: { telegram: { botToken: process.env.TELEGRAM_BOT_TOKEN || "" } },
  hooks: { enabled: true, token: process.env.GATEWAY_TOKEN || "set-a-long-random-token", path: "/hooks", allowedAgentIds: ["main"], allowRequestSessionKey: false },
};
const allowFrom = (process.env.TELEGRAM_ALLOW_FROM || "").split(",").map(s => s.trim()).filter(Boolean).map(Number);
if (allowFrom.length) config.channels.telegram.allowFrom = allowFrom;
fs.writeFileSync(path.join(STATE, "openclaw.json"), JSON.stringify(config, null, 2));

function getAutoMaxOldSpaceMb() {
  if (process.env.MAX_OLD_SPACE_MB) return Number(process.env.MAX_OLD_SPACE_MB);
  try {
    // Linux cgroup v2
    const memMax = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (memMax && memMax !== "max") {
      const bytes = Number(memMax);
      if (bytes > 0) return Math.max(128, Math.floor((bytes / 1048576) * 0.65));
    }
  } catch {}
  try {
    // Linux cgroup v1
    const memLimit = fs.readFileSync("/sys/fs/cgroup/memory/memory.limit_in_bytes", "utf8").trim();
    const bytes = Number(memLimit);
    if (bytes > 0 && bytes < 1099511627776) {
      return Math.max(128, Math.floor((bytes / 1048576) * 0.65));
    }
  } catch {}
  return 320; // safe default for 512MB box
}

const oldSpaceMb = getAutoMaxOldSpaceMb();
trace(`heap auto-tuned: oldSpace=${oldSpaceMb}MB`);

const child = spawn(NODE24, [OPENCLAW, "gateway", "--port", process.env.PORT || "18789", "--bind", "lan"], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "production",
    UV_THREADPOOL_SIZE: "2",
    NODE_COMPILE_CACHE: path.join(ROOT, ".ccache"),
    OPENCLAW_STATE_DIR: STATE,
    OPENCLAW_CONFIG_PATH: path.join(STATE, "openclaw.json"),
    NODE_OPTIONS: `--max-old-space-size=${oldSpaceMb} --max-semi-space-size=8`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { process.stdout.write(d); logStream.write(d); });
child.stderr.on("data", (d) => { process.stderr.write(d); logStream.write(d); });
trace("gateway spawned: " + NODE24);
const rssTimer = setInterval(() => {
  const m = process.memoryUsage();
  trace(`parent rss=${(m.rss / 1048576).toFixed(0)}MB heapUsed=${(m.heapUsed / 1048576).toFixed(0)}MB`);
  try {
    const s = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
    const vm = s.match(/VmRSS:\s+(\d+) kB/);
    if (vm) trace(`gateway rss=${(Number(vm[1]) / 1024).toFixed(0)}MB`);
  } catch {}
}, 60000);
rssTimer.unref();
child.on("error", (err) => { trace("spawn error: " + err.message); process.exit(1); });
child.on("exit", (code) => { trace("gateway exited code=" + code); process.exit(code ?? 1); });
