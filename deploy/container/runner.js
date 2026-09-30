#!/usr/bin/env node
/**
 * ⚡ OpenClaw Hyper-Optimized Container & Low-RAM Deployer
 * Engineered for constrained hosts (512MB - 1GB RAM: PebbleHost, Pterodactyl, low-RAM VPS)
 * Features:
 *   - Node 24.21.0 LTS Portable Sideloading
 *   - Lightpanda Ultra-Lightweight CDP Browser (~35MB RAM vs 600MB Chromium)
 *   - Aggressive V8 Memory Caps & Proactive Compact GC (--max-old-space-size=384)
 *   - Networking Modes: Public IP, Cloudflare QuickTunnel, Named Tunnel
 *   - Dynamic Origin Detection & Host-Header Fallback to prevent CSRF rejections
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = process.env.OPENCLAW_HOME || process.cwd() || '/home/container';
const NODE24_DIR = path.join(ROOT, '.node24');
const NODE24_BIN = path.join(NODE24_DIR, 'bin', 'node');
const NPM24_BIN = path.join(NODE24_DIR, 'bin', 'npm');
const STATE_DIR = path.join(ROOT, '.openclaw-state');
const BIN_DIR = path.join(ROOT, '.bin');
const CLOUDFLARED_BIN = path.join(BIN_DIR, 'cloudflared');
const LIGHTPANDA_BIN = path.join(BIN_DIR, 'lightpanda');

const PORT = parseInt(process.env.SERVER_PORT || process.env.PORT || '25613', 10);
const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.TOKEN || 'pebble-7b46e5621dcf5f5e1289cd3a5cf7c444';
const ACCESS_MODE = (process.env.ACCESS_MODE || 'public').toLowerCase();
const BROWSER_PORT = 9222;

console.log('====================================================================');
console.log('⚡  OPENCLAW HYPER-OPTIMIZED LOW-RAM RUNNER');
console.log('📦  Architecture: Node 24 LTS + Lightpanda CDP Engine');
console.log('⚙️   Memory Budget: Capped at 384MB V8 Heap (Safe for 512MB-1GB Tiers)');
console.log('====================================================================\n');

// 1. Helper: Stream Download with Redirect Handling
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    const get = (targetUrl) => {
      https.get(targetUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed with status ${res.statusCode}: ${targetUrl}`));
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve());
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    };
    get(url);
  });
}

// 2. Fetch Public IP
function getPublicIp() {
  return new Promise((resolve) => {
    https.get('https://api.ipify.org?format=json', { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data).ip); } catch { resolve(null); }
      });
    }).on('error', () => {
      https.get('https://icanhazip.com', { timeout: 3000 }, (res) => {
        let ip = '';
        res.on('data', chunk => ip += chunk);
        res.on('end', () => resolve(ip.trim() || null));
      }).on('error', () => resolve(null));
    });
  });
}

// 3. Sideload Node 24 LTS if needed
async function ensureNode24() {
  if (fs.existsSync(NODE24_BIN)) return;
  console.log('[Bootstrap] Downloading Node.js 24 LTS portable binary...');
  fs.mkdirSync(NODE24_DIR, { recursive: true });
  const tarPath = path.join(ROOT, 'node24.tar.xz');
  await downloadFile('https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz', tarPath);
  console.log('[Bootstrap] Extracting Node 24 runtime...');
  execSync(`tar -xJf "${tarPath}" --strip-components=1 -C "${NODE24_DIR}"`);
  if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
  console.log('[Bootstrap] Node 24 runtime ready.');
}

// 4. Install OpenClaw
function ensureOpenClaw() {
  const openclawMjs = path.join(ROOT, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (fs.existsSync(openclawMjs)) return;
  console.log('[Bootstrap] Installing openclaw@latest (lean prod build)...');
  const env = Object.assign({}, process.env, {
    PATH: `${path.join(NODE24_DIR, 'bin')}:${process.env.PATH}`
  });
  execSync(`"${NPM24_BIN}" install openclaw@latest --omit=dev --no-fund --no-audit --no-optional`, {
    stdio: 'inherit',
    cwd: ROOT,
    env
  });
}

// 5. Sideload and Run Lightpanda (Ultra-lean browser CDP backend)
async function startLightpanda() {
  if (!fs.existsSync(LIGHTPANDA_BIN)) {
    console.log('[Browser] Sideloading Lightpanda CDP Engine (~35MB memory footprint)...');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await downloadFile('https://github.com/lightpanda-io/browser/releases/download/0.4.1/lightpanda-x86_64-linux', LIGHTPANDA_BIN);
    fs.chmodSync(LIGHTPANDA_BIN, 0o755);
    console.log('[Browser] Lightpanda binary prepared.');
  }

  console.log('[Browser] Starting Lightpanda CDP service on 127.0.0.1:' + BROWSER_PORT);
  const lp = spawn(LIGHTPANDA_BIN, ['--host', '127.0.0.1', '--port', String(BROWSER_PORT)], {
    stdio: 'ignore',
    detached: true
  });
  lp.unref();
}

// 6. Network Tunnel Integration (QuickTunnel / Named Tunnel)
async function startCloudflareTunnel(port) {
  if (!fs.existsSync(CLOUDFLARED_BIN)) {
    console.log('[Tunnel] Downloading cloudflared binary...');
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await downloadFile('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', CLOUDFLARED_BIN);
    fs.chmodSync(CLOUDFLARED_BIN, 0o755);
  }

  if (process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    console.log('[Tunnel] Launching Cloudflare Named Tunnel...');
    const cf = spawn(CLOUDFLARED_BIN, ['tunnel', 'run', '--token', process.env.CLOUDFLARE_TUNNEL_TOKEN], {
      stdio: 'ignore',
      detached: true
    });
    cf.unref();
    return process.env.PUBLIC_DOMAIN || 'https://configured-in-cloudflare-dashboard';
  } else {
    console.log('[Tunnel] Launching Cloudflare QuickTunnel (trycloudflare.com)...');
    return new Promise((resolve) => {
      const cf = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let found = false;
      const check = (chunk) => {
        const match = chunk.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && !found) {
          found = true;
          resolve(match[0]);
        }
      };
      cf.stdout.on('data', check);
      cf.stderr.on('data', check);
      setTimeout(() => { if (!found) resolve(null); }, 10000);
    });
  }
}

// 7. Main Execution & Boot
async function boot() {
  await ensureNode24();
  ensureOpenClaw();
  await startLightpanda();

  const publicIp = await getPublicIp();
  fs.mkdirSync(STATE_DIR, { recursive: true });

  let tunnelUrl = null;
  if (ACCESS_MODE === 'quicktunnel' || ACCESS_MODE === 'tunnel' || process.env.CLOUDFLARE_TUNNEL_TOKEN) {
    tunnelUrl = await startCloudflareTunnel(PORT);
  }

  // Pre-seed configuration
  const configPath = path.join(STATE_DIR, 'openclaw.json');
  const allowedOrigins = [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `https://localhost:${PORT}`,
    `https://127.0.0.1:${PORT}`,
    '*'
  ];

  if (publicIp) {
    allowedOrigins.push(`http://${publicIp}:${PORT}`);
    allowedOrigins.push(`https://${publicIp}:${PORT}`);
  }
  if (tunnelUrl) {
    allowedOrigins.push(tunnelUrl);
  }

  const config = {
    gateway: {
      mode: 'local',
      auth: {
        mode: 'token',
        token: TOKEN
      },
      controlUi: {
        dangerouslyAllowHostHeaderOriginFallback: true,
        allowedOrigins: allowedOrigins
      }
    },
    browser: {
      enabled: true,
      provider: 'cdp',
      cdpUrl: `http://127.0.0.1:${BROWSER_PORT}`
    },
    runtime: {
      subagents: {
        maxConcurrent: 1
      }
    }
  };

  
  // Ensure config is written to all candidate locations
  const locations = [
    path.join(ROOT, ".openclaw", "openclaw.json"),
    path.join(STATE_DIR, "openclaw.json"),
    path.join(require("os").homedir(), ".openclaw", "openclaw.json")
  ];
  for (const loc of locations) {
    fs.mkdirSync(path.dirname(loc), { recursive: true });
    fs.writeFileSync(loc, JSON.stringify(config, null, 2));
  }


  // Console Connection Banner
  const directUrl = (publicIp ? `http://${publicIp}:${PORT}` : `http://localhost:${PORT}`) + `/#token=${TOKEN}`;
  const displayTunnelUrl = tunnelUrl ? `${tunnelUrl}/#token=${TOKEN}` : null;

  console.log('\n====================================================================');
  console.log('🚀  OPENCLAW RUNTIME ACTIVE');
  console.log('====================================================================');
  console.log(`🌐 Direct IP URL   : ${directUrl}`);
  if (displayTunnelUrl) {
    console.log(`🔒 Tunnel HTTPS    : ${displayTunnelUrl}`);
  }
  console.log(`🔑 Gateway Token   : ${TOKEN}`);
  console.log(`🛡️ Allowed Origins : ${allowedOrigins.join(', ')}`);
  console.log(`🌐 Browser Engine  : Lightpanda (CDP @ 127.0.0.1:${BROWSER_PORT})`);
  console.log('====================================================================\n');

  // Spawn OpenClaw with tight V8 Heap parameters & size optimizations
  const openclawMjs = path.join(ROOT, 'node_modules', 'openclaw', 'openclaw.mjs');
  const v8Args = [
    '--max-old-space-size=384',
    '--max-semi-space-size=8',
    '--initial-old-space-size=64',
    '--optimize-for-size',
    '--gc-global',
    openclawMjs,
    'gateway',
    '--port', String(PORT),
    '--bind', 'lan',
    '--token', TOKEN,
    '--allow-unconfigured'
  ];

  const env = Object.assign({}, process.env, {
    PATH: `${path.join(NODE24_DIR, 'bin')}:${process.env.PATH}`,
    NODE_ENV: 'production',
    NODE_COMPILE_CACHE: path.join(STATE_DIR, '.compile-cache'),
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_GATEWAY_TOKEN: TOKEN,
    UV_THREADPOOL_SIZE: '2',
    NODE_OPTIONS: '--max-old-space-size=384'
  });

  const child = spawn(NODE24_BIN, v8Args, {
    cwd: ROOT,
    env: env,
    stdio: 'inherit'
  });

  child.on('exit', (code, sig) => process.exit(code || 0));
}

boot().catch(err => {
  console.error('[Fatal Runner Error]:', err);
  process.exit(1);
});
