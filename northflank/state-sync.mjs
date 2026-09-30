#!/usr/bin/env node
/**
 * State snapshot sync for ephemeral Northflank disk.
 *
 * Gzips the OpenClaw state directory into a single tar.gz in memory and
 * stores it as one remote object. Zero npm dependencies: Turso uses its
 * plain HTTP API; S3 uses hand-rolled SigV4 with node:crypto.
 *
 * Remote selection via STATE_REMOTE env: "turso" or "s3".
 * Restores are skipped when the remote object is older than local
 * STATE_SYNC_MARKER (prevents a stale remote overwriting newer local state).
 */
import { createHash, createHmac } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFile, readdir, stat, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_NAME = "openclaw-state.tar.gz";
const MARKER_NAME = "STATE_SYNC_MARKER";

function log(msg) {
  process.stdout.write(`[state-sync] ${new Date().toISOString()} ${msg}\n`);
}

async function collectFiles(dir, base = dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, base, acc);
    } else {
      const info = await stat(full);
      acc.push({ rel: path.relative(base, full), size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return acc;
}

export async function pushSnapshot({ stateDir, remote }) {
  const files = await collectFiles(stateDir);
  if (files.length === 0) {
    log("state dir empty; nothing to push");
    return;
  }
  const parts = [];
  for (const file of files) {
    const header = Buffer.concat([
      Buffer.from(file.rel, "utf8"),
      Buffer.from([0]),
      Buffer.from(String(file.size), "utf8"),
      Buffer.from([0]),
    ]);
    parts.push(header, await readFile(path.join(stateDir, file.rel)));
  }
  const payload = Buffer.concat([
    Buffer.from(String(Date.now())),
    Buffer.from([0]),
    ...parts,
  ]);
  const gz = gzipSync(payload, { level: 6 });

  const stamp = String(Date.now());
  if (remote === "turso") await tursoPut(gz, stamp);
  else if (remote === "s3") await s3Put(gz, "application/gzip");
  else throw new Error(`unsupported STATE_REMOTE: ${remote}`);
  await writeFile(path.join(stateDir, MARKER_NAME), stamp);
  log(`pushed snapshot (${(gz.length / 1024).toFixed(0)} KiB, ${files.length} files)`);
}

export async function restoreSnapshot({ stateDir, remote }) {
  let object;
  if (remote === "turso") object = await tursoGet();
  else if (remote === "s3") object = await s3Get();
  else throw new Error(`unsupported STATE_REMOTE: ${remote}`);
  if (!object) {
    log("no remote snapshot yet; starting fresh");
    return;
  }

  const markerPath = path.join(stateDir, MARKER_NAME);
  let localStamp = 0;
  try {
    localStamp = Number(await readFile(markerPath, "utf8")) || 0;
  } catch {}

  const nul = Buffer.from([0]);
  const firstNul = object.indexOf(0);
  const remoteStamp = Number(object.subarray(0, firstNul).toString("utf8")) || 0;
  if (remoteStamp <= localStamp) {
    log(`remote snapshot (stamp ${remoteStamp}) not newer than local (${localStamp}); skip restore`);
    return;
  }

  await mkdir(stateDir, { recursive: true });
  let cursor = firstNul + 1;
  let restored = 0;
  const raw = gunzipSync(object.subarray(cursor));
  cursor = 0;
  while (cursor < raw.length) {
    const nameEnd = raw.indexOf(0, cursor);
    const name = raw.subarray(cursor, nameEnd).toString("utf8");
    const sizeEnd = raw.indexOf(0, nameEnd + 1);
    const size = Number(raw.subarray(nameEnd + 1, sizeEnd).toString("utf8"));
    const start = sizeEnd + 1;
    const data = raw.subarray(start, start + size);
    const target = path.resolve(stateDir, name);
    if (!target.startsWith(path.resolve(stateDir) + path.sep)) {
      throw new Error(`unsafe path in snapshot: ${name}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
    restored++;
    cursor = start + size;
  }
  await writeFile(markerPath, String(remoteStamp));
  log(`restored ${restored} files from snapshot (stamp ${remoteStamp})`);
}

async function tursoRequest(method, body) {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url || !token) throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN required");
  const base = url.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
  const response = await fetch(`${base}/blobs/${SNAPSHOT_NAME}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) {
    throw new Error(`turso ${method} failed: ${response.status} ${await response.text()}`);
  }
  return method === "GET" ? Buffer.from(await response.arrayBuffer()) : response;
}

const tursoPut = (gz) => tursoRequest("PUT", gz);
const tursoGet = () => tursoRequest("GET");

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function s3Config() {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION ?? "us-east-1";
  const accessKey = process.env.S3_ACCESS_KEY_ID;
  const secretKey = process.env.S3_SECRET_ACCESS_KEY;
  const endpoint = process.env.S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`;
  if (!bucket || !accessKey || !secretKey) {
    throw new Error("S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY required");
  }
  return { bucket, region, accessKey, secretKey, endpoint: endpoint.replace(/\/$/, "") };
}

function s3SignedRequest(method, body, contentType) {
  const { bucket, region, accessKey, secretKey, endpoint } = s3Config();
  const url = new URL(`${endpoint}/${bucket}/${SNAPSHOT_NAME}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(body ?? "").digest("hex");
  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const headers = {
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (contentType) headers["Content-Type"] = contentType;
  return { url: url.toString(), headers };
}

async function s3Put(gz, contentType) {
  const { url, headers } = s3SignedRequest("PUT", gz, contentType);
  const response = await fetch(url, { method: "PUT", headers, body: gz });
  if (!response.ok) {
    throw new Error(`s3 PUT failed: ${response.status} ${await response.text()}`);
  }
}

async function s3Get() {
  const { url, headers } = s3SignedRequest("GET", null);
  const response = await fetch(url, { method: "GET", headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`s3 GET failed: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function cleanLocalMarker(stateDir) {
  await rm(path.join(stateDir, MARKER_NAME), { force: true });
}
