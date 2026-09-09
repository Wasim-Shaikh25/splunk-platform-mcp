# Changelog

All notable changes to this project are documented here.

## 0.1.1

### Changed

- **Keep-alive is more aggressive and self-healing.** The background session
  keep-alive now pings **immediately on start** (was a ~3s delay) and defaults to a
  **120s** interval (was 240s). The loop is self-scheduling: after a **successful**
  ping it waits the full interval, but after a **failed** ping it retries quickly
  (default 15s, `SPLUNK_KEEPALIVE_RETRY_SECONDS`) instead of waiting a full interval,
  so a transient blip cannot let the SSO session quietly age out while the server
  runs. New env var `SPLUNK_KEEPALIVE_RETRY_SECONDS` (default 15).
  - Unchanged limitation: SSO cookies cannot be renewed headlessly. When the IdP's
    absolute session lifetime is reached, run the `splunk_login` tool again.

## 0.1.0

- Initial release: Dashboard Studio + Classic dashboard create/update/read, saved
  searches (reports/alerts), SPL search, SSO-cookie auth with background keep-alive
  and stale-cookie cleanup, docs-first guardrails.
