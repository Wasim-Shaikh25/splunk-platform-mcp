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
 * Interval is configurable via SPLUNK_KEEPALIVE_SECONDS (default 120s = 2 min).
 * Set SPLUNK_KEEPALIVE_SECONDS=0 to disable. After a failed ping the loop retries
 * quickly (SPLUNK_KEEPALIVE_RETRY_SECONDS, default 15s) instead of waiting a full
 * interval, so a transient blip cannot let the session quietly age out.
 */

let timer = null;
let consecutiveFailures = 0;
let staleCookieDeleted = false;

function intervalMs() {
  const raw = parseInt(process.env.SPLUNK_KEEPALIVE_SECONDS || "120", 10);
  const secs = Number.isFinite(raw) ? raw : 120;
  return secs <= 0 ? 0 : Math.max(30, secs) * 1000;
}

/** Fast retry delay after a failed ping (keeps the session warm despite a blip). */
function retryMs() {
  const raw = parseInt(process.env.SPLUNK_KEEPALIVE_RETRY_SECONDS || "15", 10);
  const secs = Number.isFinite(raw) && raw > 0 ? raw : 15;
  return Math.max(5, secs) * 1000;
}

/** Consecutive auth failures before the stale cookie file is hard-deleted. Default 3; 0 disables. */
function staleCookieThreshold() {
  const raw = parseInt(process.env.SPLUNK_STALE_COOKIE_FAILS || "3", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 3;
}

async function pingOnce() {
  try {
    // Hit an authenticated endpoint that Splunk counts as real user activity so the
    // session's inactivity timer is reset (not just a cached read). current-context is
    // the canonical "who am I" call and refreshes the web session on the proxy tier.
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
  console.error(
    `[splunk-mcp] Session keep-alive every ${ms / 1000}s (SSO cookies), fast-retry ${retryMs() / 1000}s after a miss.`
  );
  // Self-scheduling loop: ping now, then reschedule based on success/failure.
  // On success wait the full interval; on failure retry quickly so a single miss
  // can't let the session lapse before the next attempt.
  const tick = async () => {
    const ok = await pingOnce();
    const next = ok ? ms : retryMs();
    timer = setTimeout(tick, next);
    if (typeof timer.unref === "function") timer.unref();
  };
  // Fire the first ping almost immediately.
  timer = setTimeout(tick, 1000);
  if (typeof timer.unref === "function") timer.unref();
}

export function stopCookieKeepAlive() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
