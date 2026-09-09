import fs from "fs";
import path from "node:path";
import fetch from "node-fetch";
import { CONFIG } from "./config.js";
import { withCookieFileLockSync } from "./cookie-lock.js";

/**
 * Splunk management REST client.
 * - Auth: SSO cookies only (complete splunk_login once).
 * - Reaches splunkd via a probed base (web proxy path or :8089).
 * - Returns JSON (output_mode=json) parsed to objects.
 */

let resolvedRestBase = null; // { mode, base } cached after first successful probe

function readCookieArraySync(filePath) {
  return withCookieFileLockSync(filePath, () => {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) {
      throw new Error(`Invalid cookie file; delete ${filePath} and run splunk_login again.`);
    }
    return cookies;
  });
}

/** Load the raw cookie array from the primary path, falling back to a legacy file. */
function loadCookieArray() {
  const primary = readCookieArraySync(CONFIG.COOKIE_FILE);
  if (primary) return primary;
  const legacy = path.join(CONFIG.PROJECT_ROOT, "cookies", "session.json");
  if (legacy !== CONFIG.COOKIE_FILE && fs.existsSync(legacy)) {
    return readCookieArraySync(legacy);
  }
  return null;
}

/**
 * Only send cookies that belong to the Splunk host. The SSO flow also stores IdP
 * cookies (e.g. a second JSESSIONID for sso.myid.disney.com); sending those to Splunk
 * collides with Splunk's own session cookie and triggers CSRF/auth failures.
 */
function splunkHostCookies(cookies) {
  let host = "";
  try {
    host = new URL(CONFIG.SPLUNK_BASE_URL).hostname;
  } catch {
    host = "";
  }
  if (!host) return cookies;
  const matches = cookies.filter((c) => {
    const d = String(c.domain || "").replace(/^\./, "");
    return d === host || host.endsWith(`.${d}`) || d.endsWith(host);
  });
  return matches.length > 0 ? matches : cookies;
}

function cookieHeaderFrom(cookies) {
  return splunkHostCookies(cookies)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Splunk web tier requires a CSRF form key on write requests. The token lives in a
 * cookie named `splunkweb_csrf_token` or `splunkweb_csrf_token_<port>`; its value must
 * be echoed in the `X-Splunk-Form-Key` header. Returns "" if not present (e.g. token auth).
 * @param {Array<{name:string,value:string}>} cookies
 */
function csrfFormKeyFrom(cookies) {
  const hit = splunkHostCookies(cookies).find((c) =>
    /^splunkweb_csrf_token(_\d+)?$/.test(c.name)
  );
  return hit ? hit.value : "";
}

function authHeadersForCookie() {
  const cookies = loadCookieArray();
  if (!cookies || cookies.length === 0) return null;
  const headers = { Cookie: cookieHeaderFrom(cookies) };
  const csrf = csrfFormKeyFrom(cookies);
  if (csrf) headers["X-Splunk-Form-Key"] = csrf;
  return headers;
}

/**
 * Cookie-only auth. Returns the cookie header set to use for the request.
 * @returns {{ primary: Record<string,string> }}
 */
function resolveAuth() {
  const cookie = authHeadersForCookie();
  if (cookie) return { primary: cookie };
  throw new Error(
    "Not authenticated. Run the splunk_login tool once to complete SSO and save cookies."
  );
}

function withJsonOutput(pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `${pathAndQuery}${sep}output_mode=json`;
}

/** Splunk error bodies are JSON with messages[]; extract a readable line. */
function extractSplunkError(text) {
  try {
    const j = JSON.parse(text);
    const msgs = Array.isArray(j?.messages) ? j.messages : [];
    if (msgs.length) return msgs.map((m) => m.text ?? JSON.stringify(m)).join("; ");
  } catch {
    // not JSON
  }
  return text.slice(0, 500);
}

function hintForStatus(status) {
  if (status === 401) {
    return " Unauthorized: SSO session expired or was rejected. Run the splunk_login tool again to refresh your cookies.";
  }
  if (status === 403) {
    return " Forbidden: authenticated but your Splunk role lacks permission for this object (e.g. edit_view / app write access).";
  }
  if (status === 404) {
    return " Not found: check the dashboard name, owner, and app namespace.";
  }
  return "";
}

/**
 * Low-level fetch against a specific REST base, with auth + one auth-fallback retry.
 * @param {string} base
 * @param {string} pathAndQuery relative to base, must start with /services or /servicesNS
 * @param {import('node-fetch').RequestInit} init
 */
async function fetchAt(base, pathAndQuery, init) {
  const url = `${base}${pathAndQuery}`;
  const { primary } = resolveAuth();
  const baseHeaders = { Accept: "application/json", ...init.headers };
  return fetch(url, { ...init, headers: { ...baseHeaders, ...primary } });
}

/**
 * Determine which REST base actually works, caching the winner.
 * Probes with a tiny read that only needs authentication, not special roles.
 */
export async function ensureRestBase() {
  if (resolvedRestBase) return resolvedRestBase;
  const candidates = CONFIG.restBaseCandidates();
  const probePath = withJsonOutput("/services/authentication/current-context?count=1");
  const errors = [];
  for (const cand of candidates) {
    try {
      const res = await fetchAt(cand.base, probePath, { method: "GET" });
      const text = await res.text();
      if (res.ok && text.trim().startsWith("{")) {
        resolvedRestBase = cand;
        return cand;
      }
      errors.push(`${cand.mode} (${cand.base}) -> HTTP ${res.status}: ${extractSplunkError(text)}`);
    } catch (e) {
      errors.push(`${cand.mode} (${cand.base}) -> ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `Could not reach the Splunk REST API on any candidate path.\n` +
      errors.map((e) => `  - ${e}`).join("\n") +
      `\nCheck SPLUNK_BASE_URL, that you completed SSO (splunk_login tool), and whether :8089 is reachable. ` +
      `Pin the working one with SPLUNK_REST_MODE=proxy|mgmt.`
  );
}

async function parse(res) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Splunk HTTP ${res.status}: ${extractSplunkError(text)}${hintForStatus(res.status)}`);
  }
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from Splunk; got: ${text.slice(0, 200)}`);
  }
}

/**
 * Splunk's web tier (the /splunkd/__raw proxy) rejects state-changing requests as
 * CSRF unless they look like an in-app AJAX call: the `X-Splunk-Form-Key` header
 * (echoing the splunkweb_csrf_token cookie, added in authHeadersForCookie) AND
 * `X-Requested-With: XMLHttpRequest`. Both are required together on writes.
 */
const WRITE_MARKER_HEADERS = { "X-Requested-With": "XMLHttpRequest" };

/** GET JSON. @param {string} pathAndQuery */
export async function getJson(pathAndQuery) {
  const { base } = await ensureRestBase();
  const res = await fetchAt(base, withJsonOutput(pathAndQuery), { method: "GET" });
  return parse(res);
}

/**
 * POST form-encoded (Splunk REST convention) and return JSON.
 * @param {string} pathAndQuery
 * @param {Record<string, string>} form
 */
export async function postForm(pathAndQuery, form) {
  const { base } = await ensureRestBase();
  const body = new URLSearchParams(form).toString();
  const res = await fetchAt(base, withJsonOutput(pathAndQuery), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...WRITE_MARKER_HEADERS },
    body,
  });
  return parse(res);
}

/**
 * POST form-encoded and return the raw text body (for endpoints that stream
 * newline-delimited JSON, e.g. search/jobs/export). Throws on non-2xx.
 * @param {string} pathAndQuery
 * @param {Record<string, string>} form
 */
export async function postRaw(pathAndQuery, form) {
  const { base } = await ensureRestBase();
  const body = new URLSearchParams(form).toString();
  const res = await fetchAt(base, pathAndQuery, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...WRITE_MARKER_HEADERS },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Splunk HTTP ${res.status}: ${extractSplunkError(text)}${hintForStatus(res.status)}`);
  }
  return text;
}

/** DELETE and return JSON (or {deleted:true} on 200/204 with empty body). */
export async function del(pathAndQuery) {
  const { base } = await ensureRestBase();
  const res = await fetchAt(base, withJsonOutput(pathAndQuery), {
    method: "DELETE",
    headers: { ...WRITE_MARKER_HEADERS },
  });
  if (res.status === 200 || res.status === 204) {
    const text = await res.text();
    if (!text.trim()) return { deleted: true };
    try {
      return JSON.parse(text);
    } catch {
      return { deleted: true };
    }
  }
  return parse(res);
}

/** Reset the cached base (used by tests / after re-login). */
export function _resetRestBaseCache() {
  resolvedRestBase = null;
}
