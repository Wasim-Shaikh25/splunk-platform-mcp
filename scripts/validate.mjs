#!/usr/bin/env node
/**
 * Local validation:
 * 1. Syntax-check every .js under src/
 * 2. If SPLUNK_BASE_URL is set, load config and print resolved settings (no network).
 * 3. If --probe is passed AND auth is available, attempt a live capability probe
 *    (reachability, whoami, sample read). Requires prior splunk_login or SPLUNK_TOKEN.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const srcFiles = walk(path.join(root, "src")).filter((f) => f.endsWith(".js"));
let failed = false;
for (const f of srcFiles) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr || `Failed: ${f}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`OK: syntax check (${srcFiles.length} files under src/)`);

// Load config first: importing it parses .env, so we must not gate on process.env
// (an env var set outside .env would otherwise mask, or a missing one falsely skip).
let CONFIG;
try {
  ({ CONFIG } = await import("../src/config.js"));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/SPLUNK_BASE_URL is not set/.test(msg)) {
    console.log("Skip config load (set SPLUNK_BASE_URL in .env or env to validate the config module).");
    process.exit(0);
  }
  throw e;
}
console.log("OK: config loaded");
console.log(
  JSON.stringify(
    {
      SPLUNK_BASE_URL: CONFIG.SPLUNK_BASE_URL,
      locale: CONFIG.locale,
      restBaseCandidates: CONFIG.restBaseCandidates(),
      cookieFile: CONFIG.COOKIE_FILE,
      defaultApp: CONFIG.defaultApp,
    },
    null,
    2
  )
);

if (!process.argv.includes("--probe")) {
  console.log("Skip live probe (pass --probe after completing splunk_login).");
  process.exit(0);
}

try {
  const { getCurrentUsername, listDashboards } = await import("../src/dashboards.js");
  const username = await getCurrentUsername();
  console.log(`OK: authenticated as ${username}`);
  const { total } = await listDashboards({ count: 3 });
  console.log(`OK: read ${total} dashboard(s) in a sample list.`);
  console.log("Probe passed: read access confirmed. Write access still depends on your Splunk role.");
} catch (e) {
  console.error("Probe failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
