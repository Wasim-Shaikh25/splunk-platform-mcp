# splunk-platform-mcp

A Model Context Protocol (MCP) server for **reading and building Splunk dashboards**.
It talks to the Splunk management REST API (`data/ui/views`) as *you* — via browser
SSO cookies — so Splunk's own permissions decide what you can see
and edit. It supports both **Dashboard Studio (JSON)** and **Classic (Simple XML)**
dashboards, checks your edit access before updating, and always creates new
dashboards under your own profile.

It also enforces a **documentation-first** workflow: the write tools require you to
confirm you consulted the official Splunk docs before authoring SPL or a dashboard
definition.

## How it works

- **Auth**: Complete SSO once in a browser (`splunk_login`); cookies are saved and
  reused for REST calls. Cookies carry your identity, so all reads/writes are
  ACL-enforced by Splunk. (Auth is SSO-cookie only — there is no token mode.)
- **Reach**: REST is reached through the web tier proxy path
  (`{base}/{locale}/splunkd/__raw/...`, SSO-cookie friendly) with a fallback to the
  management port (`:8089`). The server probes which works and caches it. Pin it with
  `SPLUNK_REST_MODE=proxy|mgmt`.
- **Read**: `list_dashboards`, `get_dashboard` return only what your account can see.
- **Access check**: `check_dashboard_access` reads the ACL and reports `can_write`.
- **Write**: `create_dashboard` creates under your username (private by default);
  `update_dashboard` re-checks `can_write` and refuses if Splunk denies write.

## Tools

| Tool | Purpose |
|------|---------|
| `splunk_login` | Browser SSO; save cookies for REST. |
| `splunk_docs` | Return official Splunk doc references (topic: spl/studio/classic/report/alert/rest). **Use before authoring.** |
| `whoami` | Show the Splunk user the session runs as (create owner). |
| `query_splunk` | Run an SPL search and return results (runs as you). |
| `list_dashboards` | List dashboards you can see; filter by app/owner/name. |
| `get_dashboard` | Full definition + ACL + detected format for one dashboard. |
| `check_dashboard_access` | Report whether you can edit a dashboard before trying. |
| `create_dashboard` | Create a new dashboard under your profile (Studio or Classic). Requires `docsConsulted:true`. |
| `update_dashboard` | Update an existing dashboard; refuses if `can_write=false`. Requires `docsConsulted:true`. |
| `list_reports` / `get_report` | List / read reports (saved searches). |
| `create_report` / `update_report` | Create under your profile / update (access-checked). Requires `docsConsulted:true`. |
| `list_alerts` / `get_alert` | List / read alerts (scheduled triggering saved searches). |
| `create_alert` / `update_alert` | Create under your profile / update (access-checked). Requires `docsConsulted:true`. |

There is intentionally **no delete tool** — this server does not delete dashboards,
reports, or alerts.

## Reports and alerts

Both are Splunk `saved/searches` objects. A **report** is a saved search (optionally
scheduled via `cron`). An **alert** is a scheduled saved search with a trigger
condition (`number of results` / `hosts` / `sources` / `custom`), a comparator and
threshold, and optional actions. New reports/alerts are created under your profile.

## Search

`query_splunk` runs SPL via `search/jobs/export` (runs as you; Splunk enforces data
access). Consult `splunk_docs` (topic `spl`) before composing queries — SPL is
version-specific.

## Session keep-alive

While the server runs, a background loop pings a lightweight REST endpoint to keep
your Splunk session warm and warns early (on stderr) if the SSO cookie goes stale.
Interval: `SPLUNK_KEEPALIVE_SECONDS` (default 240; `0` disables). Note: SSO cookies
**cannot** be renewed headlessly — when the session truly expires, run `splunk_login`
again. The client re-reads the cookie file on every request, so re-logging in
another window is picked up with no restart.

## Documentation-first policy

Any agent using this server must read the relevant [Splunk docs](https://docs.splunk.com/)
before writing SPL or a dashboard definition, then pass `docsConsulted: true` (and a
`docsReference`) to the write tools. The tools refuse writes without it. See
`.kiro/steering/splunk-platform-authoring.md`. This protects accuracy — SPL and the
dashboard schemas are version-specific and must not be guessed.

## Setup

```bash
npm install
npm run install-browser   # one-time: Chromium for Playwright SSO
```

Configure via your MCP client (`mcp.json`) env block, or a local `.env`
(see `.env.example`). Minimum:

```
SPLUNK_BASE_URL=https://splunk.<your-org>.com
```

Then, in your client, run the `splunk_login` tool (or `npm run login`) and complete
SSO in the window that opens.

### Example mcp.json entry

```json
{
  "mcpServers": {
    "splunk-platform": {
      "command": "node",
      "args": ["c:/MCP Projects/splunk-platform-mcp/src/index.js"],
      "env": {
        "SPLUNK_BASE_URL": "https://splunk.example.com"
      }
    }
  }
}
```

Then run the `splunk_login` tool (or `npm run login`) and complete SSO. Auth is
SSO-cookie only.

## Validate

```bash
npm run validate            # syntax + config (no network)
npm run validate -- --probe # live: whoami + sample read (after completing login)
npm test                    # unit tests (format detection, docs gate)
```

## Notes

- Reading works with any authenticated account. **Writing** requires your Splunk role
  to allow it (e.g. the `edit_view` capability and write access to the target app).
  If your account is read-only, create/update will be refused by Splunk's ACL — the
  tools surface that clearly rather than failing with a raw 403.
- New dashboards are created private (owned by you). Change sharing in Splunk if
  others need access.

## npm

Package name: **`@svasimahmed283/splunk-platform-mcp`**. Install or run via MCP:

```json
"args": ["-y", "@svasimahmed283/splunk-platform-mcp@0.1.2"]
```

Repository: [Wasim-Shaikh25/splunk-platform-mcp](https://github.com/Wasim-Shaikh25/splunk-platform-mcp).
