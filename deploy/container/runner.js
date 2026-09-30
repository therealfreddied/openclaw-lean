/**
 * OpenClaw Lean Runner for Pterodactyl & PebbleHost (Low-RAM Tier)
 * - Uses .tar.gz (native gzip, no xz dependency)
 * - Auto-provisions standalone Node 24.21.0 LTS
 * - Sideloads Lightpanda CDP Browser
 * - Strictly enforces OPENCLAW_CONFIG_PATH with wildcard allowedOrigins
 * - V8 384MB memory optimization
 */

const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");

const ROOT = process.cwd();
const PORT = process.env.SERVER_PORT || process.env.PORT || "25613";
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "pebble-7b46e5621dcf5f5e1289cd3a5cf7c444";
const STATE_DIR = path.join(ROOT, ".openclaw");
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");

console.log("==========================================");
console.log("   OPENCLAW LEAN CONTAINER RUNNER");
console.log("==========================================");
console.log("Working Dir :", ROOT);
console.log("Listen Port :", PORT);
console.log("State Dir   :", STATE_DIR);
console.log("Config Path :", CONFIG_PATH);
console.log("==========================================");

// 1. Ensure basic directories
try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, ".bin"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, ".node24"), { recursive: true });
} catch (e) {
  console.error("Failed to create directories:", e.message);
}

// 2. Write deterministic openclaw.json
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
        `http://54.39.90.209:${PORT}`,
        `https://54.39.90.209:${PORT}`,
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`
      ],
      dangerouslyAllowHostHeaderOriginFallback: true
    }
  },
  browser: {
    provider: "cdp",
    cdpUrl: "http://127.0.0.1:9222"
  }
};

try {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  const homeDir = process.env.HOME || "/home/container";
  const homeConfigDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(homeConfigDir, { recursive: true });
  fs.writeFileSync(path.join(homeConfigDir, "openclaw.json"), JSON.stringify(config, null, 2));
  console.log("[1/5] Configuration written successfully.");
} catch (e) {
  console.error("Failed to write config:", e.message);
}

// 3. Sideload Node 24 LTS (.tar.gz, no xz required)
const node24Bin = path.join(ROOT, ".node24", "bin", "node");
const npm24Bin = path.join(ROOT, ".node24", "bin", "npm");

let nodeExec = process.execPath;
let npmExec = "npm";

if (!fs.existsSync(node24Bin)) {
  console.log("[2/5] Downloading standalone Node 24.21.0 LTS (.tar.gz)...");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const nodeTar = `node-v24.21.0-linux-${arch}.tar.gz`;
  const nodeUrl = `https://nodejs.org/dist/v24.21.0/${nodeTar}`;

  const curlRes = spawnSync("curl", ["-fsSL", nodeUrl, "-o", nodeTar], { stdio: "inherit" });
  if (curlRes.status !== 0) {
    console.error("Error downloading Node 24 binary.");
  } else {
    console.log("Extracting Node 24...");
    const tarRes = spawnSync("tar", ["-zxf", nodeTar, "--strip-components=1", "-C", path.join(ROOT, ".node24")], { stdio: "inherit" });
    try { fs.unlinkSync(nodeTar); } catch (e) {}
    if (tarRes.status !== 0) {
      console.error("Error extracting Node 24 archive.");
    }
  }
}

if (fs.existsSync(node24Bin)) {
  nodeExec = node24Bin;
  npmExec = npm24Bin;
  console.log(`[2/5] Node runtime ready: ${nodeExec}`);
} else {
  console.warn(`[2/5] Node 24 sideload not found, falling back to host node: ${nodeExec}`);
}

// 4. Check or install openclaw npm package
const openclawCliCandidates = [
  path.join(ROOT, "node_modules", "openclaw", "openclaw.mjs"),
  path.join(ROOT, ".node24", "lib", "node_modules", "openclaw", "openclaw.mjs"),
  path.join(ROOT, "node_modules", ".bin", "openclaw")
];

let openclawCli = openclawCliCandidates.find(p => fs.existsSync(p));

if (!openclawCli) {
  console.log("[3/5] Installing OpenClaw package via npm...");
  // Create minimal package.json if missing to prevent npm errors
  const pkgPath = path.join(ROOT, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "openclaw-container", version: "1.0.0", private: true }));
  }

  const installEnv = {
    ...process.env,
    PATH: `${path.join(ROOT, ".node24", "bin")}:${process.env.PATH}`
  };

  const npmRes = spawnSync(npmExec, ["install", "openclaw@latest", "--no-audit", "--no-fund"], {
    stdio: "inherit",
    env: installEnv
  });

  openclawCli = openclawCliCandidates.find(p => fs.existsSync(p));
  if (!openclawCli || npmRes.status !== 0) {
    console.error("[3/5] Failed to install openclaw. Retrying with --force...");
    spawnSync(npmExec, ["install", "openclaw@latest", "--force", "--no-audit", "--no-fund"], {
      stdio: "inherit",
      env: installEnv
    });
    openclawCli = openclawCliCandidates.find(p => fs.existsSync(p));
  }
}

console.log(`[3/5] OpenClaw CLI resolved: ${openclawCli}`);

// 5. Sideload Lightpanda CDP Browser
const lpBin = path.join(ROOT, ".bin", "lightpanda");
if (!fs.existsSync(lpBin)) {
  console.log("[4/5] Downloading Lightpanda headless browser (~35MB RAM footprint)...");
  const lpArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const lpUrl = `https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-${lpArch}-linux`;
  spawnSync("curl", ["-fsSL", lpUrl, "-o", lpBin], { stdio: "inherit" });
  try { fs.chmodSync(lpBin, 0o755); } catch (e) {}
}

if (fs.existsSync(lpBin)) {
  console.log("[4/5] Starting Lightpanda CDP service on 127.0.0.1:9222...");
  const lpProcess = spawn(lpBin, ["--host", "127.0.0.1", "--port", "9222"], {
    stdio: "ignore",
    detached: true
  });
  lpProcess.unref();
}

// 6. Launch OpenClaw Gateway with V8 low-RAM tuning
console.log(`[5/5] Launching OpenClaw Gateway on port ${PORT}...`);

const v8Args = [
  "--max-old-space-size=384",
  "--max-semi-space-size=8",
  "--optimize-for-size",
  "--gc-interval=100"
];

const env = {
  ...process.env,
  HOME: process.env.HOME || "/home/container",
  OPENCLAW_HOME: process.env.HOME || "/home/container",
  OPENCLAW_STATE_DIR: STATE_DIR,
  OPENCLAW_CONFIG_PATH: CONFIG_PATH,
  UV_THREADPOOL_SIZE: "2",
  NODE_ENV: "production",
  PATH: `${path.join(ROOT, ".node24", "bin")}:${path.join(ROOT, ".bin")}:${process.env.PATH}`
};

if (!openclawCli) {
  console.error("CRITICAL: openclaw.mjs entrypoint could not be found.");
  process.exit(1);
}

const gatewayProcess = spawn(nodeExec, [...v8Args, openclawCli, "gateway", "--port", String(PORT)], {
  env,
  stdio: "inherit"
});

gatewayProcess.on("exit", (code) => {
  console.log(`OpenClaw process exited with code ${code}`);
  process.exit(code || 0);
});
