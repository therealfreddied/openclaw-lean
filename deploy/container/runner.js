/**
 * Standalone Complete OpenClaw Lean Runner for PebbleHost / Pterodactyl / SkailarHost
 * Includes automatic background device/browser approval loop.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawnSync, spawn } = require("child_process");

const ROOT = process.cwd();
const PORT = process.env.SERVER_PORT || process.env.PORT || "25613";
const DEFAULT_TOKEN = Buffer.from("cGViYmxlLTdiNDZlNTYyMWRjZjVmNWUxMjg5Y2QzYTVjZjdjNDQ0", "base64").toString("utf8");
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || DEFAULT_TOKEN;
const STATE_DIR = path.join(ROOT, ".openclaw");
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");

console.log("==================================================");
console.log("   OPENCLAW ALL-IN-ONE RUNNER WITH AUTO-APPROVE   ");
console.log("==================================================");
console.log("Target Port :", PORT);
console.log("State Dir   :", STATE_DIR);
console.log("Config Path :", CONFIG_PATH);
console.log("==================================================");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (targetUrl) => {
      const client = targetUrl.startsWith("https") ? https : http;
      client.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(dest); } catch (e) {}
          return reject(new Error("HTTP " + res.statusCode + " for " + targetUrl));
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => resolve());
        });
      }).on("error", (err) => {
        file.close();
        try { fs.unlinkSync(dest); } catch (e) {}
        reject(err);
      });
    };
    get(url);
  });
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, ".bin"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, ".node24"), { recursive: true });

  // 1. Write strictly valid openclaw.json
  const config = {
    gateway: {
      mode: "local",
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
          "http://209.222.98.205:" + PORT,
          "https://209.222.98.205:" + PORT,
          "http://localhost:" + PORT,
          "http://127.0.0.1:" + PORT
        ],
        dangerouslyAllowHostHeaderOriginFallback: true
      }
    },
    browser: {
      enabled: true,
      cdpUrl: "http://127.0.0.1:9222"
    }
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  const homeDir = process.env.HOME || "/home/container";
  const homeConfigDir = path.join(homeDir, ".openclaw");
  fs.mkdirSync(homeConfigDir, { recursive: true });
  fs.writeFileSync(path.join(homeConfigDir, "openclaw.json"), JSON.stringify(config, null, 2));
  console.log("[1/4] Config written (mode=local, strict schema).");

  // 2. Sideload Node 24.21.0 LTS if needed
  const node24Bin = path.join(ROOT, ".node24", "bin", "node");
  const npm24Bin = path.join(ROOT, ".node24", "bin", "npm");
  let nodeExec = process.execPath;
  let npmExec = "npm";

  if (!fs.existsSync(node24Bin)) {
    console.log("[2/4] Downloading Node 24.21.0 LTS (.tar.gz)...");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const nodeTar = path.join(ROOT, "node-v24.21.0-linux-" + arch + ".tar.gz");
    const nodeUrl = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-" + arch + ".tar.gz";

    try {
      await download(nodeUrl, nodeTar);
      console.log("Extracting Node 24...");
      spawnSync("tar", ["-zxf", nodeTar, "--strip-components=1", "-C", path.join(ROOT, ".node24")], { stdio: "inherit" });
      try { fs.unlinkSync(nodeTar); } catch (e) {}
    } catch (e) {
      console.error("Node 24 download failed, fallback to container node:", e.message);
    }
  }

  if (fs.existsSync(node24Bin)) {
    nodeExec = node24Bin;
    npmExec = npm24Bin;
    console.log("[2/4] Using Node runtime: " + nodeExec);
  } else {
    console.log("[2/4] Using container Node runtime: " + nodeExec);
  }

  // 3. Ensure openclaw is installed
  const openclawCliCandidates = [
    path.join(ROOT, "node_modules", "openclaw", "openclaw.mjs"),
    path.join(ROOT, ".node24", "lib", "node_modules", "openclaw", "openclaw.mjs"),
    path.join(ROOT, "node_modules", ".bin", "openclaw")
  ];
  let openclawCli = openclawCliCandidates.find(p => fs.existsSync(p));

  if (!openclawCli) {
    console.log("[3/4] Installing openclaw@latest via npm...");
    const pkgPath = path.join(ROOT, "package.json");
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: "openclaw-container", version: "1.0.0", private: true }, null, 2));
    }
    const installEnv = Object.assign({}, process.env, {
      PATH: path.join(ROOT, ".node24", "bin") + ":" + process.env.PATH
    });
    spawnSync(npmExec, ["install", "openclaw@latest", "--no-audit", "--no-fund"], {
      stdio: "inherit",
      env: installEnv
    });
    openclawCli = openclawCliCandidates.find(p => fs.existsSync(p));
  }

  console.log("[3/4] OpenClaw entrypoint: " + openclawCli);

  // 4. Sideload Lightpanda CDP Browser
  const lpBin = path.join(ROOT, ".bin", "lightpanda");
  if (!fs.existsSync(lpBin)) {
    console.log("Downloading Lightpanda headless browser (~35MB RAM footprint)...");
    const lpArch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const lpUrl = "https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-" + lpArch + "-linux";
    try {
      await download(lpUrl, lpBin);
      try { fs.chmodSync(lpBin, 0o755); } catch (e) {}
    } catch (e) {
      console.warn("Lightpanda download skipped:", e.message);
    }
  }

  if (fs.existsSync(lpBin)) {
    console.log("Starting Lightpanda CDP service on 127.0.0.1:9222...");
    const lpProcess = spawn(lpBin, ["--host", "127.0.0.1", "--port", "9222"], {
      stdio: "ignore",
      detached: true
    });
    lpProcess.unref();
  }

  // 5. Environment & V8 memory optimization
  const v8Args = [
    "--max-old-space-size=384",
    "--max-semi-space-size=8",
    "--optimize-for-size",
    "--gc-interval=100"
  ];

  const gatewayEnv = Object.assign({}, process.env, {
    HOME: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_CONFIG_PATH: CONFIG_PATH,
    UV_THREADPOOL_SIZE: "2",
    NODE_ENV: "production",
    PATH: path.join(ROOT, ".node24", "bin") + ":" + path.join(ROOT, ".bin") + ":" + process.env.PATH
  });

  if (!openclawCli) {
    console.error("CRITICAL: openclaw.mjs entrypoint could not be located after npm install.");
    process.exit(1);
  }

    // 6. Background Auto-Approver: automatically approves any browser / device pair request
  setInterval(() => {
    try {
      const listProc = spawnSync(nodeExec, [
        openclawCli, "devices", "list", "--json",
        "--url", "http://127.0.0.1:" + PORT,
        "--token", TOKEN
      ], {
        env: gatewayEnv,
        encoding: "utf8"
      });
      if (listProc.stdout) {
        try {
          const data = JSON.parse(listProc.stdout);
          const pending = data.pending || [];
          for (const req of pending) {
            const reqId = req.requestId || req.id;
            if (reqId) {
              console.log("[Auto-Approve] ⚡ Auto-approving pending device/browser pairing: " + reqId);
              const appProc = spawnSync(nodeExec, [
                openclawCli, "devices", "approve", reqId,
                "--url", "http://127.0.0.1:" + PORT,
                "--token", TOKEN
              ], {
                env: gatewayEnv,
                encoding: "utf8"
              });
              console.log("[Auto-Approve] Result:", appProc.stdout || appProc.stderr);
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }, 2000);

  // 7. Launch Gateway
  console.log("[4/4] Starting OpenClaw Gateway on port " + PORT + "...");
  const gatewayArgs = v8Args.concat([
    openclawCli,
    "gateway",
    "--allow-unconfigured",
    "--port",
    String(PORT)
  ]);

  const gatewayProcess = spawn(nodeExec, gatewayArgs, {
    env: gatewayEnv,
    stdio: "inherit"
  });

  gatewayProcess.on("exit", (code) => {
    console.log("OpenClaw gateway stopped with code " + code);
    process.exit(code || 0);
  });
}

main().catch(err => {
  console.error("FATAL Runner Error:", err);
  process.exit(1);
});
