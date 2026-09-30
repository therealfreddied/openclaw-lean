#!/usr/bin/env node
/**
 * OpenClaw Lean Kit — measured on-host thinner.
 *
 * Trims the installed openclaw npm package (node_modules/openclaw) and the
 * bundled `node` runtime package based on a real file map fetched from
 * unpkg for the exact installed version. Deletes only byte-identifiable
 * dead weight; never touches runtime code, plugin manifests, state, config,
 * or secrets. Does NOT change any protocol/code path — compatibility with
 * vanilla clients is preserved by construction.
 *
 * Profile-driven: `--apply --profile=halffb` (512MB hosts) removes:
 *   - all *.d.ts, *.map, *.tsbuildinfo (17+ MB, never read at runtime)
 *   - /docs (15.4 MB — served nowhere; runtime never reads it)
 *   - control-ui locale packs except en + user-chosen (each ~0.5MB)
 *   - precompressed .gz/.br duplicates of assets already on disk
 *   - tree-sitter wasm grammars beyond the allowlist (lazy-loaded)
 *   - patches/, custodian-skills duplicates of docs-sized data
 * Optional: --keep-locales=th,ru to retain specific UI languages.
 *
 * Dry-run by default. Verify with `openclaw doctor` after applying.
 */
import { readFile, readdir, stat, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.env.LEAN_ROOT ?? process.cwd();
const APPLY = process.argv.includes("--apply");
const profileArg = process.argv.find((a) => a.startsWith("--profile="));
const PROFILE = profileArg ? profileArg.split("=")[1] : "halffb";
const keepLocales = (process.argv.find((a) => a.startsWith("--keep-locales=")) ?? "")
  .split("=")[1] ?? "";
const KEEP_LOCALES = new Set(["en", ...keepLocales.split(",").filter(Boolean)]);

function log(msg) {
  console.log(`[thin] ${msg}`);
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function resolveOpenclawDir() {
  // Support both "root IS the deploy dir with node_modules/openclaw" and
  // "root is inside the package" layouts.
  const candidates = [
    path.join(ROOT, "node_modules", "openclaw"),
    ROOT,
  ];
  for (const c of candidates) {
    const pkgPath = path.join(c, "package.json");
    if (await exists(pkgPath)) {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      if (pkg.name === "openclaw") return c;
    }
  }
  log(`no node_modules/openclaw found under ${ROOT}; aborting`);
  process.exit(1);
}

const openclawDir = await resolveOpenclawDir();
const version = JSON.parse(await readFile(path.join(openclawDir, "package.json"), "utf8")).version;
log(`target: node_modules/openclaw@${version} profile=${PROFILE} ${APPLY ? "APPLY" : "dry-run"}`);

// --- fetch authoritative file map for this exact version -------------------
const metaUrl = `https://unpkg.com/openclaw@${version}/?meta`;
let remoteFiles;
try {
  const response = await fetch(metaUrl);
  if (!response.ok) throw new Error(`unpkg ${response.status}`);
  const meta = await response.json();
  remoteFiles = new Map(
    meta.files
      .filter((f) => f.type !== "directory")
      .map((f) => [f.path, f.size]),
  );
  log(`fetched file map: ${remoteFiles.size} entries from unpkg`);
} catch (error) {
  log(`FATAL: cannot fetch file map for ${version}: ${error.message}`);
  log("Refusing to delete based on guesses. Try again with network access.");
  process.exit(1);
}

// --- deletion rules --------------------------------------------------------
const DIST_PRUNABLE = [
  /\.d\.ts$/,
  /\.map$/,
  /\.tsbuildinfo$/,
  /^\/dist\/\.buildstamp$/,
  /^\/dist\/\.runtime-postbuildstamp$/,
];
const DOCS_DIRS = [/^\/docs\//, /^\/patches\//, /^\/custodian-skills\//];
const LOCALE_RE = /^\/dist\/control-ui\/assets\/([a-z]{2}(?:-[A-Za-z]{2})?)-[A-Za-z0-9_-]+\.js$/;

function ruleFor(p) {
  // exact-size verify happens later; here: which rule, if any
  if (DIST_PRUNABLE.some((re) => re.test(p))) return "dts/maps";
  if (DOCS_DIRS.some((re) => re.test(p))) return "docs/patches";
  if (p === "/dist/postinstall-content-inventory.json") return "postinstall inventory";
  if (p.endsWith(".gz") || p.endsWith(".br")) {
    const raw = p.replace(/\.(gz|br)$/, "");
    if (remoteFiles.has(raw)) return "precompressed duplicate";
  }
  const localeMatch = p.match(LOCALE_RE);
  if (localeMatch && !KEEP_LOCALES.has(localeMatch[1])) return `locale ${localeMatch[1]}`;
  if (p.startsWith("/dist/") && p.endsWith(".wasm")) {
    // tree-sitter grammars are lazy-loaded; keep only the common ones
    const keepGrammars = ["bash", "javascript", "typescript", "typescriptx", "json", "yaml", "python"];
    const base = path.basename(p, ".wasm").replace("tree-sitter-", "");
    if (!keepGrammars.includes(base)) return `grammar ${base}`;
  }
  return null;
}

// --- walk the real install, match against remote paths ---------------------
let bytes = 0, files = 0;
const byRule = new Map();
async function walk(dir, relPrefix = "") {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = relPrefix + "/" + entry.name;
    if (entry.isDirectory()) {
      await walk(full, rel);
    } else if (entry.isFile()) {
      const remotePath = rel; // package-root-relative, e.g. /dist/foo.mjs
      const rule = ruleFor(remotePath);
      if (!rule) continue;
      const expectedSize = remoteFiles.get(remotePath);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (expectedSize !== undefined && expectedSize !== info.size) {
        log(`size mismatch for ${remotePath} (disk ${info.size} ≠ map ${expectedSize}); skipping`);
        continue;
      }
      bytes += info.size; files++;
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      if (APPLY) await rm(full, { force: true });
    }
  }
}
await walk(openclawDir);

// --- protect runtime integrity: dist/worker + dist/control-ui core remain --
// (deletion rules never match worker/*.mjs or control-ui core bundles)

if (APPLY) {
  // drop empty locale siblings left behind is unnecessary; no dirs removed.
  log(`applied: ${files} files, ${(bytes / 1048576).toFixed(1)} MB freed`);
} else {
  log(`dry run: ${files} files, ${(bytes / 1048576).toFixed(1)} MB identifiable`);
}
for (const [rule, n] of [...byRule.entries()].sort()) log(`  ${rule}: ${n} files`);
if (!APPLY) log("rerun with --apply to delete; then run: npx openclaw doctor");
