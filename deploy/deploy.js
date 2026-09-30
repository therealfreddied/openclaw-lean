#!/usr/bin/env node
/**
 * Automated OpenClaw Multi-Host Deployer for Pterodactyl / PebbleHost / SkailarHost Panels
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const USAGE = `
Usage:
  node deploy.js --panel <panel_url> --key <api_key> --server <server_id> [--start-file index.js] [--restart]

Example:
  node deploy.js --panel https://panel.skailarhost.com --key ptlc_xxx --server fbdc60ce --restart
  node deploy.js --panel https://panel.pebblehost.com --key ptlc_yyy --server 27da9f1e --restart
`;

const args = process.argv.slice(2);
function getArg(flag, def = null) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
}
const hasFlag = (flag) => args.includes(flag);

const panelUrl = getArg("--panel");
const apiKey = getArg("--key");
const serverId = getArg("--server");
const startFile = getArg("--start-file", "index.js");
const shouldRestart = hasFlag("--restart");

if (!panelUrl || !apiKey || !serverId) {
  console.error(USAGE);
  process.exit(1);
}

function api(endpoint, method = "GET", body = null, raw = false) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, panelUrl);
    const headers = {
      "Authorization": "Bearer " + apiKey,
      "Accept": "application/json",
      "User-Agent": "OpenClaw-Deployer/1.0"
    };
    if (raw) headers["Content-Type"] = "text/plain";
    else if (body) headers["Content-Type"] = "application/json";

    const req = https.request(url, { method, headers }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on("error", reject);
    if (body) {
      if (typeof body === "string") req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function main() {
  console.log("==================================================");
  console.log("       OPENCLAW PANEL AUTOMATED DEPLOYER          ");
  console.log("==================================================");
  console.log("Panel     :", panelUrl);
  console.log("Server ID :", serverId);

  console.log("\n[1/4] Fetching server details & allocations...");
  const srv = await api(`/api/client/servers/${serverId}`);
  if (srv.status !== 200) {
    console.error("❌ Failed to authenticate or access server:", srv.data || srv.raw);
    process.exit(1);
  }
  const name = srv.data.attributes.name;
  const allocations = srv.data.attributes.relationships?.allocations?.data || [];
  const primaryAlloc = allocations.find(a => a.attributes.is_default) || allocations[0];
  const ip = primaryAlloc ? (primaryAlloc.attributes.ip_alias || primaryAlloc.attributes.ip) : "UNKNOWN";
  const port = primaryAlloc ? primaryAlloc.attributes.port : "UNKNOWN";

  console.log(`✅ Connected to: "${name}" (${ip}:${port})`);

  console.log("\n[2/4] Reading deployment runner script...");
  const runnerPath = path.join(__dirname, "pterodactyl", "pebble_start.js");
  const runnerCode = fs.readFileSync(runnerPath, "utf8");

  console.log(`\n[3/4] Uploading runner to /${startFile} and /pebble_start.js...`);
  const w1 = await api(`/api/client/servers/${serverId}/files/write?file=${encodeURIComponent(startFile)}&directory=%2F`, "POST", runnerCode, true);
  const w2 = await api(`/api/client/servers/${serverId}/files/write?file=pebble_start.js&directory=%2F`, "POST", runnerCode, true);
  console.log(`✅ Upload status: ${w1.status} / ${w2.status}`);

  if (shouldRestart) {
    console.log("\n[4/4] Sending restart signal to container...");
    const pwr = await api(`/api/client/servers/${serverId}/power`, "POST", { signal: "restart" });
    console.log(`✅ Power signal sent: ${pwr.status}`);
  }

  console.log("\n==================================================");
  console.log("🎉 DEPLOYMENT COMPLETE!");
  console.log(`Target Control UI: http://${ip}:${port}/#token=pebble-7b46e5621dcf5f5e1289cd3a5cf7c444`);
  console.log("==================================================");
}

main().catch(console.error);
