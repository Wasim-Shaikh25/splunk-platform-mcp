import path from "node:path";

export function sanitizeSessionLabel(label) {
  return String(label || "default")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 96);
}

/**
 * Cookie file path for Splunk SSO cookies. Named per MCP server key (if provided)
 * or per host, so multiple Splunk instances don't clobber each other.
 * @param {string} projectRoot
 * @param {string} baseUrl
 * @param {string | undefined} mcpServerKey
 */
export function resolveSplunkCookiePath(projectRoot, baseUrl, mcpServerKey) {
  let name = "session";
  const key = typeof mcpServerKey === "string" && mcpServerKey.trim();
  if (key) {
    name = `session-${sanitizeSessionLabel(mcpServerKey)}`;
  } else {
    try {
      const host = new URL(baseUrl).hostname;
      name = `session-${sanitizeSessionLabel(host)}`;
    } catch {
      name = "session";
    }
  }
  return path.join(projectRoot, "cookies", `${name}.json`);
}
