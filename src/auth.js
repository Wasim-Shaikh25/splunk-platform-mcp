import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { CONFIG } from "./config.js";
import { withCookieFileLockSync } from "./cookie-lock.js";
import { buildLoginToolResultText, logSsoFallbackToStderr } from "./sso-login-messages.js";

/**
 * `page.evaluate` throws if navigation happens mid-call (SSO / IdP redirects).
 * Return false and let the next poll retry instead of failing the whole login.
 * @param {import('playwright').Page} page
 * @param {() => Promise<boolean>} runEvaluate
 */
async function probeSessionWithNavigationGuard(page, runEvaluate) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    return await runEvaluate();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      /Execution context was destroyed|most likely because of a navigation/i.test(msg) ||
      /Target page, context or browser has been closed/i.test(msg)
    ) {
      return false;
    }
    throw e;
  }
}

/**
 * Login entry URL. Use the Splunk web host so SSO round-trips set cookies for the
 * Splunk origin (a bare IdP portal host would not).
 */
function resolveLoginEntryUrl() {
  const base = CONFIG.SPLUNK_BASE_URL;
  let login = CONFIG.LOGIN_URL;
  try {
    const baseHost = new URL(base).hostname;
    const loginHost = new URL(login).hostname;
    if (loginHost !== baseHost) {
      const fallback = `${base}/${CONFIG.locale}/account/login`;
      console.error(
        `[splunk-mcp] SPLUNK_LOGIN_URL host (${loginHost}) differs from SPLUNK_BASE_URL host (${baseHost}).`
      );
      console.error(`[splunk-mcp] Using Splunk login entry so SSO round-trips through Splunk: ${fallback}`);
      login = fallback;
    }
  } catch {
    // keep CONFIG.LOGIN_URL
  }
  return login;
}

/**
 * Probe REST from the page (same-origin cookies) via the web proxy path, to detect
 * login without waiting the full timeout. Must not trust `response.ok` alone: an
 * unauthenticated redirect can yield 200 HTML.
 */
async function splunkSessionLooksReady(page) {
  const base = CONFIG.SPLUNK_BASE_URL.replace(/\/$/, "");
  const probe = `${base}/${CONFIG.locale}/splunkd/__raw/services/authentication/current-context?output_mode=json&count=1`;
  return probeSessionWithNavigationGuard(page, () =>
    page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        if (!r.ok) return false;
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        const text = await r.text();
        if (text.trim().startsWith("<")) return false;
        if (!ct.includes("json") && !text.trim().startsWith("{")) return false;
        const data = JSON.parse(text);
        const entry = Array.isArray(data?.entry) ? data.entry[0] : null;
        return Boolean(entry?.content?.username || entry?.name);
      } catch {
        return false;
      }
    }, probe)
  );
}

/**
 * Open a browser for SSO; store Playwright cookie export for REST calls.
 * Polls the REST proxy and saves as soon as the session works.
 * @returns {{ cookiePath: string; cookieCount: number; sessionProbeOk: boolean }}
 */
export async function loginWithSSO() {
  fs.mkdirSync(path.dirname(CONFIG.COOKIE_FILE), { recursive: true });

  const browser = await chromium.launch({ headless: false });
  let ready = false;
  let cookies = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const entryUrl = resolveLoginEntryUrl();

    console.error("[splunk-mcp] Opening browser for SSO login...");
    console.error(`[splunk-mcp] Entry: ${entryUrl}`);
    await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 180_000 });

    console.error(
      "[splunk-mcp] Complete SSO in this window. Waiting until Splunk REST accepts the session (or timeout)..."
    );
    const deadline = Date.now() + CONFIG.LOGIN_WAIT_MS;
    await new Promise((r) => setTimeout(r, Math.min(1500, CONFIG.LOGIN_POLL_MS)));

    while (Date.now() < deadline) {
      if (await splunkSessionLooksReady(page)) {
        ready = true;
        console.error("[splunk-mcp] Session detected (REST current-context OK). Saving cookies...");
        break;
      }
      await new Promise((r) => setTimeout(r, CONFIG.LOGIN_POLL_MS));
    }

    if (!ready) {
      console.error(
        `[splunk-mcp] REST did not confirm login within ${CONFIG.LOGIN_WAIT_MS / 1000}s — loading base URL once more to capture cookies anyway.`
      );
    }

    console.error(`[splunk-mcp] Loading ${CONFIG.SPLUNK_BASE_URL} to capture Splunk cookies...`);
    try {
      await page.goto(CONFIG.SPLUNK_BASE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
    } catch (e) {
      console.error("[splunk-mcp] Warning: final Splunk load failed:", e?.message ?? e);
    }

    cookies = await context.cookies();
    withCookieFileLockSync(CONFIG.COOKIE_FILE, () => {
      fs.writeFileSync(CONFIG.COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf8");
    });

    if (!Array.isArray(cookies) || cookies.length === 0) {
      console.error(
        "[splunk-mcp] WARNING: No cookies captured — SSO may not have completed on this origin (redirects, pop-up blockers, or IdP blocking automation)."
      );
      logSsoFallbackToStderr({
        cookieFile: CONFIG.COOKIE_FILE,
        logPrefix: "[splunk-mcp]",
      });
    } else {
      console.error("[splunk-mcp] Login complete. Session stored at", CONFIG.COOKIE_FILE);
    }

    return { cookiePath: CONFIG.COOKIE_FILE, cookieCount: cookies.length, sessionProbeOk: ready };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[splunk-mcp] Browser login error:", msg);
    logSsoFallbackToStderr({
      cookieFile: CONFIG.COOKIE_FILE,
      logPrefix: "[splunk-mcp]",
    });
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Text for the MCP tool response after splunk_login. */
export function loginToolResultText(result) {
  return buildLoginToolResultText({
    cookieFile: result.cookiePath,
    cookieCount: result.cookieCount,
    sessionProbeOk: result.sessionProbeOk,
  });
}
