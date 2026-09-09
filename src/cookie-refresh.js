import { getJson, _resetRestBaseCache } from "./splunk-rest.js";
import { deleteCookieFileSync } from "./cookie-lock.js";
import { CONFIG } from "./config.js";

/**
 * Background session keep-alive.
 *
 * What this CAN do:
 *  - Periodically ping a lightweight REST endpoint so Splunk keeps the session warm
 *    (many Splunk sessions have an inactivity/TTL timeout; regular use resets it).
 *  - Detect when the session has gone stale (ping starts returning 401) and surface
 *    a clear, actionable warning to stderr.
 *  - Pick up a fresher cookie automatically: cookies are read from disk on every
 *    request, so if you re-run `splunk_login` in another window, the next ping uses
 *    the new file with no restart.
 *
 * What this CANNOT do:
 *  - Silently re-authenticate against the SSO/IdP (that requires an interactive
 *    browser round-trip). When the session is truly expired, a human must run the
 *    `splunk_login` tool again.
 *
 * Interval is configurable via SPLUNK_KEEPALIVE_SECONDS (default 240s = 4 min).
 * Set SPLUNK_KEEPALIVE_SECONDS=0 to disable.
 */

let timer = null;
let consecutiveFailures = 0;
let staleCookieDeleted = false;

function intervalMs() {
  const raw = parseInt(process.env.SPLUNK_KEEPALIVE_SECONDS || "240", 10);
  const secs = Number.isFinite(raw) ? raw : 240;
  return secs <= 0 ? 0 : Math.max(30, secs) * 1000;
}

/** Consecutive auth failures before the stale cookie file is hard-deleted. Default 3; 0 disables. */
function staleCookieThreshold() {
  const raw = parseInt(process.env.SPLUNK_STALE_COOKIE_FAILS || "3", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

async function pingOnce() {
  try {
    await getJson("/services/authentication/current-context?count=1");
    if (consecutiveFailures > 0) {
      console.error("[splunk-mcp] Session keep-alive recovered — REST is responding again.");
    }
    consecutiveFailures = 0;
    staleCookieDeleted = false;
    return true;
  } catch (e) {
    consecutiveFailures += 1;
    const msg = e instanceof Error ? e.message : String(e);
    // A transient network blip shouldn't sound alarms; escalate wording after a few misses.
    // Only auth rejections count toward stale-cookie deletion — never network errors.
    const isAuthFailure = /HTTP 401|HTTP 403/.test(msg) || /CSRF|authenticate|Unauthorized/i.test(msg);
    if (isAuthFailure) {
      console.error(
        `[splunk-mcp] Session keep-alive: Splunk rejected the session (attempt ${consecutiveFailures}). ` +
          `The SSO cookie may have expired. Run the splunk_login tool again to refresh it.`
      );
      _resetRestBaseCache();
      maybeDeleteStaleCookie();
    } else {
      // Network/other error: log but do NOT count toward deletion.
      consecutiveFailures -= 1; // don't let transient network blips trip the threshold
      console.error(
        `[splunk-mcp] Session keep-alive ping failed (network/other, not counted): ${msg}`
      );
    }
    return false;
  }
}

/** Hard-delete the cookie file only after N consecutive auth failures (safe against transient blips). */
function maybeDeleteStaleCookie() {
  const threshold = staleCookieThreshold();
  if (threshold === 0 || staleCookieDeleted) return;
  if (consecutiveFailures >= threshold) {
    const deleted = deleteCookieFileSync(CONFIG.COOKIE_FILE);
    staleCookieDeleted = true;
    if (deleted) {
      console.error(
        `[splunk-mcp] Deleted stale cookie file after ${consecutiveFailures} consecutive auth failures: ${CONFIG.COOKIE_FILE}. ` +
          `Run the splunk_login tool to re-authenticate.`
      );
    }
  }
}

/**
 * Start the background keep-alive loop. Safe to call once at server startup.
 * No-op if disabled via SPLUNK_KEEPALIVE_SECONDS=0.
 */
export function startCookieKeepAlive() {
  if (timer) return; // already running
  const ms = intervalMs();
  if (ms === 0) {
    console.error("[splunk-mcp] Session keep-alive disabled (SPLUNK_KEEPALIVE_SECONDS=0).");
    return;
  }
  console.error(`[splunk-mcp] Session keep-alive every ${ms / 1000}s (SSO cookies).`);
  // First ping shortly after start, then on the interval.
  timer = setInterval(() => {
    void pingOnce();
  }, ms);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive just for this
  setTimeout(() => void pingOnce(), 3000).unref?.();
}

export function stopCookieKeepAlive() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
