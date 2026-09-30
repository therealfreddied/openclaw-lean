/**
 * openclaw-lean - Production Low-RAM Pterodactyl & Container Launcher
 * Compatible with Node >= 22 Host, automatically bootstraps Node 24.x LTS & OpenClaw
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const child_process = require('child_process');

const HOME = process.env.HOME || '/home/container';
const NODE24_DIR = path.join(HOME, '.node24');
const NODE24_BIN = path.join(NODE24_DIR, 'bin', 'node');
const OPENCLAW_DIR = path.join(HOME, '.openclaw');
const CONFIG_PATH = path.join(OPENCLAW_DIR, 'openclaw.json');

// Memory & Engine Limits
process.env.UV_THREADPOOL_SIZE = '4';
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --max-old-space-size=384 --expose-gc`;

function log(msg) {
  console.log(`[openclaw-runner] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

function ensureDirectories() {
  [OPENCLAW_DIR, NODE24_DIR, path.join(HOME, '.bin')].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });
}

function ensureConfig() {
  const port = parseInt(process.env.SERVER_PORT || '50049', 10);
  const token = process.env.OPENCLAW_TOKEN || 'pebble-7b46e5621dcf5f5e1289cd3a5cf7c444';
  
  const baseConfig = {
    meta: {
      migrations: {
        modelPolicyAllowlist: true
      }
    },
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: port,
      auth: {
        mode: 'token',
        token: token
      },
      controlUi: {
        enabled: true,
        allowedOrigins: ['*'],
        dangerouslyAllowHostHeaderOriginFallback: true,
        dangerouslyDisableDeviceAuth: true
      }
    },
    plugins: {
      deny: [
        'cua-computer',
        'linux-node',
        'talk-voice',
        'azure-speech',
        'apple-fm',
        'ollama',
        'geolocation',
        'beam',
        'device-pair',
        'canvas',
        'file-transfer'
      ]
    },
    browser: {
      enabled: false
    },
    diagnostics: {
      enabled: false
    },
    telemetry: {
      enabled: false
    }
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(baseConfig, null, 2), 'utf8');
    log(`Generated new config at ${CONFIG_PATH} (port ${port})`);
  } else {
    try {
      const cur = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      let modified = false;
      if (!cur.gateway) { cur.gateway = baseConfig.gateway; modified = true; }
      if (cur.gateway.mode !== 'local') { cur.gateway.mode = 'local'; modified = true; }
      if (cur.gateway.bind !== 'lan') { cur.gateway.bind = 'lan'; modified = true; }
      if (cur.gateway.port !== port) { cur.gateway.port = port; modified = true; }
      if (!cur.gateway.controlUi) { cur.gateway.controlUi = baseConfig.gateway.controlUi; modified = true; }
      if (cur.gateway.controlUi.dangerouslyDisableDeviceAuth !== true) {
        cur.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
        modified = true;
      }
      if (cur.browser && cur.browser.provider) {
        delete cur.browser.provider;
        cur.browser.enabled = false;
        modified = true;
      }
      if (modified) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2), 'utf8');
        log('Updated existing config with compatibility fixes.');
      }
    } catch (e) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(baseConfig, null, 2), 'utf8');
    }
  }
}

function patchOpenClawDist(distPath) {
  if (!fs.existsSync(distPath)) return;
  try {
    const files = fs.readdirSync(distPath);
    for (const f of files) {
      if (f.endsWith('.mjs') || f.endsWith('.js')) {
        const full = path.join(distPath, f);
        let code = fs.readFileSync(full, 'utf8');
        let altered = false;
        
        // Patch WebCrypto device pairing requirement on non-HTTPS origins
        if (code.includes('CONTROL_UI_DEVICE_IDENTITY_REQUIRED')) {
          code = code.replace(/CONTROL_UI_DEVICE_IDENTITY_REQUIRED/g, 'ALLOW_DIRECT_IP_AUTH');
          altered = true;
        }
        if (altered) {
          fs.writeFileSync(full, code, 'utf8');
          log(`Patched runtime file: ${f}`);
        }
      }
    }
  } catch (e) {
    log(`Dist patch error: ${e.message}`);
  }
}

function installNode24() {
  log('Checking Node 24 runtime...');
  if (fs.existsSync(NODE24_BIN)) {
    log('Node 24 binary present.');
    return true;
  }

  log('Downloading Node v24.21.0 tarball...');
  const tarballUrl = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz';
  const destTar = path.join(HOME, 'node24.tar.gz');

  child_process.execSync(`curl -fsSL "${tarballUrl}" -o "${destTar}" || wget -qO "${destTar}" "${tarballUrl}"`, { stdio: 'inherit' });
  log('Extracting Node 24...');
  child_process.execSync(`tar -xzf "${destTar}" -C "${NODE24_DIR}" --strip-components=1`, { stdio: 'inherit' });
  if (fs.existsSync(destTar)) fs.unlinkSync(destTar);
  log('Node 24 extracted successfully.');
  return true;
}

function launchGateway() {
  ensureDirectories();
  ensureConfig();

  // Find node executable
  let nodeBin = 'node';
  if (fs.existsSync(NODE24_BIN)) {
    nodeBin = NODE24_BIN;
  } else {
    try {
      installNode24();
      if (fs.existsSync(NODE24_BIN)) nodeBin = NODE24_BIN;
    } catch (e) {
      log(`Node 24 bootstrap failed, falling back to system node: ${e.message}`);
    }
  }

  // Check OpenClaw module
  let openclawMjs = path.join(HOME, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(openclawMjs)) {
    log('Installing openclaw package...');
    child_process.execSync('npm install openclaw@2026.9.7 --no-audit --no-fund --omit=dev', { cwd: HOME, stdio: 'inherit' });
  }

  const distDir = path.join(HOME, 'node_modules', 'openclaw', 'dist');
  patchOpenClawDist(distDir);

  log(`Launching OpenClaw Gateway with ${nodeBin}...`);
  const port = process.env.SERVER_PORT || '50049';
  const token = process.env.OPENCLAW_TOKEN || 'pebble-7b46e5621dcf5f5e1289cd3a5cf7c444';

  console.log('========================================================');
  console.log(`CONTROL UI URL: http://${process.env.SERVER_IP || 'HOST_IP'}:${port}/#token=${token}`);
  console.log('========================================================');

  const args = [
    openclawMjs,
    'gateway',
    '--port', port,
    '--bind', 'lan',
    '--allow-unconfigured'
  ];

  const proc = child_process.spawn(nodeBin, args, {
    cwd: HOME,
    env: {
      ...process.env,
      PATH: `${path.join(NODE24_DIR, 'bin')}:${process.env.PATH}`,
      NODE_PATH: path.join(HOME, 'node_modules')
    },
    stdio: 'inherit'
  });

  proc.on('exit', (code, sig) => {
    log(`Gateway exited with code ${code}, signal ${sig}. Restarting in 5 seconds...`);
    setTimeout(launchGateway, 5000);
  });
}

launchGateway();
