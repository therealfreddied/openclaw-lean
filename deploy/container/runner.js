/**
 * OpenClaw Lean Runner for Pterodactyl & PebbleHost (Low-RAM Tier)
 * - Auto-provisions standalone Node 24 LTS into .node24
 * - Auto-provisions Lightpanda CDP Browser into .bin/lightpanda
 * - Sets OPENCLAW_CONFIG_PATH explicitly to eliminate Origin check failures
 * - Enforces V8 memory cap at 384MB with aggressive GC
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const http = require("http");

const ROOT = process.cwd();
const PORT = process.env.SERVER_PORT || process.env.PORT || 25613;
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "pebble-7b46e5621dcf5f5e1289cd3a5cf7c444";
const STATE_DIR = path.join(ROOT, ".openclaw");
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");

console.log("=== OpenClaw Lean Runner Starting ===");
console.log("Root directory:", ROOT);
console.log("Port:", PORT);
console.log("Token:", TOKEN);

// 1. Ensure directories exist
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(path.join(ROOT, ".bin"), { recursive: true });

// 2. Write deterministic openclaw.json with wildcard allowedOrigins & origin fallback
const config = {
  gateway: {
    bind: "lan",
    port: Number(PORT),
    auth: {
      mode: "token",
      token: TOKEN
    },
    controlUi: {
      enabled: true,
      allowedOrigins: [
        "*",
        "http://54.39.90.209:" + PORT,
        "https://54.39.90.209:" + PORT,
        "http://localhost:" + PORT,
        "http://127.0.0.1:" + PORT
      ],
      dangerouslyAllowHostHeaderOriginFallback: true
    }
  },
  browser: {
    provider: "cdp",
    cdpUrl: "http://127.0.0.1:9222"
  }
};

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
// Also mirror to fallback location
const homeDir = process.env.HOME || "/home/container";
const homeConfigDir = path.join(homeDir, ".openclaw");
fs.mkdirSync(homeConfigDir, { recursive: true });
fs.writeFileSync(path.join(homeConfigDir, "openclaw.json"), JSON.stringify(config, null, 2));

console.log("✓ Config written to:", CONFIG_PATH);

// 3. Sideload Node 24 if needed
const node24Bin = path.join(ROOT, ".node24", "bin", "node");
const npm24Bin = path.join(ROOT, ".node24", "bin", "npm");

let nodeExec = process.execPath;
let npmExec = "npm";

if (!fs.existsSync(node24Bin)) {
  console.log("Installing standalone Node 24.21.0 LTS...");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const nodeTar = "node-v24.21.0-linux-" + arch + ".tar.xz";
  const nodeUrl = "https://nodejs.org/dist/v24.21.0/" + nodeTar;

  spawnSync("curl", ["-fsSL", nodeUrl, "-o", nodeTar], { stdio: "inherit" });
  fs.mkdirSync(path.join(ROOT, ".node24"), { recursive: true });
  spawnSync("tar", ["-xf", nodeTar, "--strip-components=1", "-C", path.join(ROOT, ".node24")], { stdio: "inherit" });
  try { fs.unlinkSync(nodeTar); } catch (e) {}
}

if (fs.existsSync(node24Bin)) {
  nodeExec = node24Bin;
  npmExec = npm24Bin;
  console.log("✓ Using Node 24:", nodeExec);
}

// 4. Install openclaw package if not present
const openclawCli = path.join(ROOT, "node_modules", "openclaw", "openclaw.mjs");
if (!fs.existsSync(openclawCli)) {
  console.log("Installing openclaw locally via npm...");
  spawnSync(npmExec, ["install", "openclaw@latest", "--no-audit", "--no-fund"], { stdio: "inherit" });
}

// 5. Sideload Lightpanda CDP Browser if not present
const lpBin = path.join(ROOT, ".bin", "lightpanda");
if (!fs.existsSync(lpBin)) {
  console.log("Downloading Lightpanda headless browser (~35MB RAM footprint)...");
  const lpArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const lpUrl = "https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-" + lpArch + "-linux";
  spawnSync("curl", ["-fsSL", lpUrl, "-o", lpBin], { stdio: "inherit" });
  try { fs.chmodSync(lpBin, 0o755); } catch (e) {}
}

// 6. Launch Lightpanda in background
if (fs.existsSync(lpBin)) {
  console.log("Starting Lightpanda CDP on 127.0.0.1:9222...");
  const lpProcess = spawn(lpBin, ["--host", "127.0.0.1", "--port", "9222"], {
    stdio: "ignore",
    detached: true
  });
  lpProcess.unref();
}

// 7. Launch OpenClaw Gateway with strict ENV and V8 low-RAM tuning
console.log("🚀 Launching OpenClaw Gateway on port " + PORT + "...");

const v8Args = [
  "--max-old-space-size=384",
  "--max-semi-space-size=8",
  "--optimize-for-size",
  "--gc-interval=100"
];

const env = {
  ...process.env,
  HOME: homeDir,
  OPENCLAW_HOME: homeDir,
  OPENCLAW_STATE_DIR: STATE_DIR,
  OPENCLAW_CONFIG_PATH: CONFIG_PATH,
  UV_THREADPOOL_SIZE: "2",
  NODE_ENV: "production",
  PATH: path.join(ROOT, ".node24", "bin") + ":" + path.join(ROOT, ".bin") + ":" + process.env.PATH
};

const gatewayProcess = spawn(nodeExec, [...v8Args, openclawCli, "gateway", "--port", String(PORT)], {
  env,
  stdio: "inherit"
});

gatewayProcess.on("exit", (code) => {
  console.log("OpenClaw process exited with code " + code);
  process.exit(code || 0);
});
