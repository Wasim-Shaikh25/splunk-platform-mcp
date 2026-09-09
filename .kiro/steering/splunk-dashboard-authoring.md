---
inclusion: always
---

# Splunk Dashboard Authoring — Documentation First (Mandatory)

This steering governs any work that authors SPL or Splunk dashboard definitions
through the `splunk-dashboard-mcp` server. It is a hard requirement, not a
suggestion, and exists to protect accuracy: SPL commands, Dashboard Studio JSON,
and Classic Simple XML all have version-specific rules that must not be guessed.

## The rule

Before you write or modify any SPL query, Dashboard Studio JSON, Classic Simple XML,
report, or alert, you MUST first consult the official Splunk documentation for the
exact commands and schema you are using. Verify command syntax, function signatures,
argument order, dashboard schema, and alert/report fields against the docs — do not
rely on memory or assumption. This applies to `query_splunk`, dashboards, reports,
and alerts alike.

Call the `splunk_docs` tool (topic: `spl`, `studio`, `classic`, `report`, `alert`, or
`rest`) to get the canonical references, and read the relevant sections before
authoring.

## Enforcement

The write tools enforce this mechanically:

- `create_dashboard`, `update_dashboard`, `create_report`, `update_report`,
  `create_alert`, and `update_alert` all require `docsConsulted: true`.
- They will refuse the operation otherwise, returning the doc links to read.
- Always pass `docsReference` with the specific doc URL or section you used, so the
  change has an audit trail of what informed it.

There is no delete tool. This server never deletes dashboards, reports, or alerts;
do not attempt to build or invoke deletion through it.

Passing `docsConsulted: true` without actually reading the docs defeats the purpose
and is a policy violation. Only set it after you have verified syntax and schema
against the documentation.

## Authoring workflow

1. `splunk_docs` — pull the references for your format (SPL / Studio / Classic).
2. Read the relevant command and schema pages; confirm every command and field.
3. For a new dashboard: `create_dashboard` (creates under your own profile).
4. For an existing one: `check_dashboard_access` first, then `update_dashboard`
   (it re-checks `can_write` and refuses if Splunk denies write).
5. Prefer validating SPL against the docs' examples before embedding it in a panel.

## Identity and access

Every call runs as the logged-in Splunk user (SSO cookie or token). Splunk's own
ACLs decide what is visible and writable — this server does not bypass them. New
dashboards are always created under the caller's profile (private by default).
Never attempt to work around a `can_write=false` result; request access or create a
personal copy instead.
