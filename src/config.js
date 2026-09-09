import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { findMcpServerEnvForEntryScript } from "./mcp-server-discovery.js";
import { resolveSplunkCookiePath } from "./session-path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENTRY_SCRIPT = path.join(PROJECT_ROOT, "src", "index.js");

const mcpServerEntry = findMcpServerEnvForEntryScript(ENTRY_SCRIPT);

function loadEnvFile() {
  const envPath = path.join(PROJECT_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** Merge non-secret values from the discovered mcp.json block without overwriting injected env. */
function applyMcpEnvFromUserConfig() {
  const env = mcpServerEntry?.env;
  if (!env || typeof env !== "object") return;
  for (const [key, val] of Object.entries(env)) {
    if (typeof val === "string" && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();
applyMcpEnvFromUserConfig();

const baseRaw = process.env.SPLUNK_BASE_URL?.replace(/\/$/, "").trim();
if (!baseRaw) {
  throw new Error(
    "SPLUNK_BASE_URL is not set. Add it under your MCP server env in mcp.json (the entry whose args point to this project's src/index.js), then restart your client. Example: https://splunk.disney.com"
  );
}

const locale = (process.env.SPLUNK_LOCALE || "en-US").trim();
const mgmtPort = (() => {
  const n = parseInt(process.env.SPLUNK_MGMT_PORT || "8089", 10);
  return Number.isFinite(n) && n > 0 ? n : 8089;
})();

const loginDefault = `${baseRaw}/${locale}/account/login`;

/**
 * Build the ordered list of REST base candidates the client will probe.
 * `proxy` routes through the web tier (works with SSO cookies); `mgmt` hits :8089 directly.
 */
function restBaseCandidates() {
  const pinned = String(process.env.SPLUNK_REST_MODE || "").toLowerCase().trim();
  const proxyBase = `${baseRaw}/${locale}/splunkd/__raw`;
  let mgmtBase = "";
  try {
    const u = new URL(baseRaw);
    mgmtBase = `${u.protocol}//${u.hostname}:${mgmtPort}`;
  } catch {
    mgmtBase = "";
  }
  const proxy = { mode: "proxy", base: proxyBase };
  const mgmt = mgmtBase ? { mode: "mgmt", base: mgmtBase } : null;

  if (pinned === "proxy") return [proxy];
  if (pinned === "mgmt" && mgmt) return [mgmt];
  // default: prefer proxy (SSO-cookie friendly), fall back to mgmt
  return mgmt ? [proxy, mgmt] : [proxy];
}

const cookieFile = resolveSplunkCookiePath(PROJECT_ROOT, baseRaw, process.env.SPLUNK_MCP_SERVER_KEY);

export const CONFIG = {
  SPLUNK_BASE_URL: baseRaw,
  locale,
  mgmtPort,
  LOGIN_URL: process.env.SPLUNK_LOGIN_URL || loginDefault,
  COOKIE_FILE: cookieFile,
  restBaseCandidates,
  /** Owner namespace for create/update. Empty until resolved from Splunk or SPLUNK_OWNER. */
  ownerOverride: process.env.SPLUNK_OWNER?.trim() || "",
  defaultApp: process.env.SPLUNK_DEFAULT_APP?.trim() || "search",
  LOGIN_WAIT_MS: Math.max(
    30_000,
    (parseInt(process.env.SPLUNK_LOGIN_WAIT_SECONDS || "90", 10) || 90) * 1000
  ),
  LOGIN_POLL_MS: Math.max(500, parseInt(process.env.SPLUNK_LOGIN_POLL_MS || "2000", 10) || 2000),
  PROJECT_ROOT,
  mcpServerKey: mcpServerEntry?.key ?? null,
};
