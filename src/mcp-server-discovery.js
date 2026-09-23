import fs from "fs";
import os from "node:os";
import path from "path";

/**
 * Locate the mcp.json server block whose args point at this project's entry script,
 * so we can read its `env` (base URL, token, etc.) the same way the running client does.
 * Checks both Cursor (~/.cursor/mcp.json) and Kiro (~/.kiro/settings/mcp.json) user configs.
 * @param {string} entryScriptAbsolute
 * @param {string[]} [legacyServerKeys]
 * @param {string} [preferredKeyEnvVar]
 */
export function findMcpServerEnvForEntryScript(
  entryScriptAbsolute,
  legacyServerKeys = [
    "splunk-platform",
    "splunk-platform-mcp",
    "splunk-dashboard",
    "splunk-dashboard-mcp",
  ],
  preferredKeyEnvVar = "SPLUNK_MCP_SERVER_KEY"
) {
  const markerNorm = path.normalize(path.resolve(entryScriptAbsolute)).toLowerCase();

  const candidatePaths = [
    path.join(os.homedir(), ".cursor", "mcp.json"),
    path.join(os.homedir(), ".kiro", "settings", "mcp.json"),
  ];

  const matchesPath = (arg) => {
    if (typeof arg !== "string" || !arg.trim()) return false;
    try {
      const resolved = path.resolve(arg.trim());
      return path.normalize(resolved).toLowerCase() === markerNorm;
    } catch {
      return false;
    }
  };

  const pathMatches = [];
  const legacyHits = [];

  for (const mcpPath of candidatePaths) {
    if (!fs.existsSync(mcpPath)) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
    } catch {
      continue;
    }
    const servers = data?.mcpServers;
    if (!servers || typeof servers !== "object") continue;

    for (const [serverKey, server] of Object.entries(servers)) {
      const args = server?.args;
      if (Array.isArray(args) && args.some(matchesPath)) {
        const env = server.env && typeof server.env === "object" ? server.env : {};
        pathMatches.push({ key: serverKey, env: /** @type {Record<string, string>} */ (env) });
      }
    }

    for (const legacyKey of legacyServerKeys) {
      const env = servers[legacyKey]?.env;
      if (env && typeof env === "object") {
        legacyHits.push({ key: legacyKey, env: /** @type {Record<string, string>} */ (env) });
      }
    }
  }

  if (pathMatches.length === 1) {
    return pathMatches[0];
  }
  if (pathMatches.length > 1) {
    const want = process.env[preferredKeyEnvVar]?.trim();
    if (want) {
      const hit = pathMatches.find((m) => m.key === want);
      if (hit) return hit;
    }
    return pathMatches[0];
  }

  if (legacyHits.length > 0) return legacyHits[0];

  return null;
}
