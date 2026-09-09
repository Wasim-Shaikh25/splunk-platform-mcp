/**
 * Shared, testable text builders for login result and SSO-fallback guidance.
 * Auth is SSO-cookie only, so guidance is about completing/retrying SSO.
 * Kept free of Playwright/config imports so unit tests can call them directly.
 */

/**
 * @param {{ cookieFile: string; logPrefix: string }} p
 */
export function logSsoFallbackToStderr({ cookieFile, logPrefix }) {
  console.error(
    `${logPrefix} SSO cookies could not be captured. Try:\n` +
      `${logPrefix}   1) Re-run the login and complete SSO fully in the opened window.\n` +
      `${logPrefix}   2) Delete ${cookieFile} and retry if the session went stale.\n` +
      `${logPrefix}   3) Confirm SPLUNK_BASE_URL is the web host you actually log into.`
  );
}

/**
 * @param {{ cookieFile: string; cookieCount: number; sessionProbeOk: boolean }} p
 */
export function buildLoginToolResultText({ cookieFile, cookieCount, sessionProbeOk }) {
  if (cookieCount > 0 && sessionProbeOk) {
    return (
      `Login complete. Splunk REST accepted the session.\n` +
      `Saved ${cookieCount} cookie(s) to ${cookieFile}.\n` +
      `You can now list and read dashboards. Writes still depend on your Splunk role (edit_view).`
    );
  }
  if (cookieCount > 0 && !sessionProbeOk) {
    return (
      `Captured ${cookieCount} cookie(s) at ${cookieFile}, but Splunk REST did not confirm the session yet.\n` +
      `Try a read (list_dashboards). If it 401s, re-run the login and complete SSO fully in the opened window.`
    );
  }
  return (
    `No cookies were captured at ${cookieFile}.\n` +
    `SSO may not have completed on the Splunk origin (redirects, pop-up blockers, or IdP blocking automation).\n` +
    `Re-run the login and finish SSO in the opened window.`
  );
}
