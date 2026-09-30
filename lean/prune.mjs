#!/usr/bin/env node
/**
 * OpenClaw Lean Kit — on-host disk pruner.
 *
 * Deletes only files the runtime never reads, so the deployed footprint
 * shrinks without touching any code path, schema, or protocol surface.
 * Protocol-inert by construction: dist/ runtime code, UI assets, package
 * manifests, plugin manifests, and node_modules runtime files are NEVER
 * matched here.
 *
 * Dry-run by default. Pass --apply to actually delete.
 */
import { readdir, stat, rm, readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.env.LEAN_ROOT ?? process.cwd();
const APPLY = process.argv.includes("--apply");

const DIR_RULES = [
  /^\.github\/$/,
  /^\.vscode\/$/,
  /^tests?\/$/,
  /^__tests__\/$/,
  /^__mocks__\/$/,
  /^test-fixtures\/$/,
  /^fixtures\/$/,
  /^\.snapshots?\/$/,
  /^docs?\//,
  /^CHANGELOG\//,
  /^examples?\/$/,
  /^benchmarks?\//,
];

const FILE_RULES = [
  /\.map$/,
  /\.d\.ts$/,
  /\.tsbuildinfo$/,
  /\.md$/i,
  /\.mdx$/i,
  /\.podspec$/,
  /(^|\/)\.npmignore$/,
  /(^|\/)AUTHORS$/i,
  /(^|\/)CONTRIBUTING(\.md)?$/i,
  /(^|\/)SECURITY(\.md)?$/i,
  /(^|\/)CODE_OF_CONDUCT(\.md)?$/i,
  /(^|\/)\.github-.*$/,
  /(^|\/)\.travis\.yml$/,
  /(^|\/)\.eslintrc(\..+)?$/,
  /(^|\/)\.prettierrc(\..+)?$/,
  /(^|\/)jest\.config\..+$/,
  /(^|\/)tsconfig\..*\.json$/,
];

// Never touch: runtime code, schemas, manifests, state, secrets, our kit.
const PROTECTED = [
  /(^|\/)ui\//,
  /(^|\/)public\//,
  /(^|\/)assets\//,
  /(^|\/)package\.json$/,
  /(^|\/)\.plugin\.json$/,
  /(^|\/)openclaw\.json$/,
  /(^|\/)\.env$/,
  /(^|\/)gateway\.log$/,
  /(^|\/)state\//,
  /(^|\/)state$/,
  /node_modules\/\.bin\//,
  /(^|\/)bin\//,
  /openclaw\.mjs$/,
  /node-sqlite\.mjs$/,
  /node-version\.mjs$/,
  /node-runtime-.*\.mjs$/,
  /node-host-launcher\.mjs$/,
  /node-compile-cache\.mjs$/,
  /gateway-run-argv\.mjs$/,
  /gateway-shutdown-budget\.mjs$/,
  /cli-root-options\.mjs$/,
];

// dist/ code is protected, but dead weight inside dist/ is not:
// sourcemaps, type declarations, and build stamps are never read at runtime.
const DIST_PRUNABLE = [
  /(^|\/)dist\/.*\.map$/,
  /(^|\/)dist\/.*\.d\.ts$/,
  /(^|\/)dist\/.*\.tsbuildinfo$/,
  /(^|\/)dist\/\.buildstamp$/,
  /(^|\/)dist\/\.runtime-postbuildstamp$/,
];

let bytes = 0;
let files = 0;
let dirs = 0;

function isProtected(rel) {
  return PROTECTED.some((re) => re.test(rel));
}

function dirMatchesRules(rel) {
  const parts = rel.split("/");
  return parts.some((part) =>
    DIR_RULES.some((re) => re.test(part + "/")),
  );
}

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (isProtected(rel)) continue;
    if (entry.isDirectory()) {
      if (dirMatchesRules(rel)) {
        const info = await sizeOf(full);
        if (APPLY) await rm(full, { recursive: true, force: true });
        bytes += info;
        dirs++;
        continue;
      }
      await walk(full);
    } else if (entry.isFile()) {
      const inheritDir = dirMatchesRules(path.dirname(rel) === "." ? "" : path.dirname(rel));
      const prunable =
        inheritDir ||
        FILE_RULES.some((re) => re.test(rel)) ||
        DIST_PRUNABLE.some((re) => re.test("/" + rel));
      if (prunable) {
        const info = await stat(full).catch(() => null);
        if (info) {
          bytes += info.size;
          files++;
          if (APPLY) await rm(full, { force: true });
        }
      }
    }
  }
}

async function sizeOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        const info = await stat(full).catch(() => null);
        if (info) total += info.size;
      }
    }
  }
  return total;
}

// Safety: refuse to run where openclaw's package is not present.
try {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const hasOpenclaw =
    (pkg.dependencies && pkg.dependencies.openclaw) ||
    (pkg.devDependencies && pkg.devDependencies.openclaw);
  if (!hasOpenclaw) throw new Error("no openclaw dependency");
} catch {
  console.error(`[prune] ${ROOT} does not look like an openclaw deploy root; aborting.`);
  process.exit(1);
}

await walk(ROOT);

const mb = (bytes / 1048576).toFixed(1);
console.log(`[prune] ${APPLY ? "deleted" : "would delete"}: ${files} files, ${dirs} dirs, ${mb} MB ${APPLY ? "freed" : "identifiable"}`);
if (!APPLY) console.log("[prune] dry run only — rerun with --apply to delete");
