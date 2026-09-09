import { CONFIG } from "./config.js";
import { getJson, postForm } from "./splunk-rest.js";
import { getCurrentUsername } from "./dashboards.js";
import { assertDocsConsulted } from "./docs.js";
import { buildReportForm, buildAlertForm } from "./saved-search-format.js";

export { buildReportForm, buildAlertForm };

/**
 * Reports and alerts in Splunk are both `saved/searches` objects.
 *  - A "report" is a saved search (optionally scheduled) with alerting disabled.
 *  - An "alert" is a saved search with alerting enabled: alert_type + a schedule
 *    (is_scheduled=1, cron_schedule) + trigger condition + optional actions.
 *
 * Everything runs as the logged-in user; Splunk ACLs decide visibility and write.
 * New objects are created under the user's own namespace (their profile). Writes
 * require docsConsulted=true (documentation-first) and go through the CSRF-safe
 * postForm in splunk-rest.js.
 */

function summarize(entry) {
  const acl = entry?.acl ?? {};
  const c = entry?.content ?? {};
  return {
    name: entry?.name,
    app: acl?.app ?? null,
    owner: acl?.owner ?? null,
    sharing: acl?.sharing ?? null,
    canWrite: acl?.can_write ?? null,
    search: c?.search ?? null,
    isScheduled: c?.is_scheduled ?? null,
    cronSchedule: c?.cron_schedule ?? null,
    alertType: c?.alert_type ?? null,
    isAlert:
      (c?.is_scheduled === true || c?.is_scheduled === "1") &&
      c?.alert_type != null &&
      c?.alert_type !== "always",
    disabled: c?.disabled ?? null,
  };
}

/**
 * List saved searches you can see, optionally filtered to only alerts or only reports.
 * @param {{ app?: string; owner?: string; query?: string; kind?: "all"|"report"|"alert"; count?: number }} [p]
 */
export async function listSavedSearches(p = {}) {
  const app = (p.app && p.app.trim()) || "-";
  const owner = (p.owner && p.owner.trim()) || "-";
  const count = Math.min(Math.max(1, p.count ?? 50), 200);
  const data = await getJson(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/saved/searches?count=${count}&sort_mode=natural`
  );
  const entries = Array.isArray(data?.entry) ? data.entry : [];
  let items = entries.map(summarize);
  if (p.kind === "alert") items = items.filter((i) => i.isAlert);
  else if (p.kind === "report") items = items.filter((i) => !i.isAlert);
  if (p.query && p.query.trim()) {
    const q = p.query.trim().toLowerCase();
    items = items.filter((i) => i.name && i.name.toLowerCase().includes(q));
  }
  return { total: items.length, items };
}

/**
 * Get one saved search (report or alert) with its config + ACL.
 * @param {{ name: string; app?: string; owner?: string }} p
 */
export async function getSavedSearch(p) {
  if (!p.name) throw new Error("get: name is required.");
  const app = (p.app && p.app.trim()) || CONFIG.defaultApp;
  const owner = (p.owner && p.owner.trim()) || "-";
  const data = await getJson(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/saved/searches/${encodeURIComponent(p.name)}`
  );
  const entry = Array.isArray(data?.entry) ? data.entry[0] : null;
  if (!entry) throw new Error(`No saved search named "${p.name}" in app "${app}".`);
  return { ...summarize(entry), content: entry.content };
}

async function createSaved(form, app) {
  const owner = await getCurrentUsername();
  const targetApp = (app && app.trim()) || CONFIG.defaultApp;
  const res = await postForm(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(targetApp)}/saved/searches`,
    form
  );
  const entry = Array.isArray(res?.entry) ? res.entry[0] : null;
  return { created: true, name: entry?.name ?? form.name, owner, app: entry?.acl?.app ?? targetApp };
}

async function updateSaved(name, form, p) {
  const existing = await getSavedSearch({ name, app: p.app, owner: p.owner });
  if (existing.canWrite === false) {
    throw new Error(
      `update refused: no edit access to "${name}" (owner="${existing.owner}", sharing="${existing.sharing}", can_write=false). Ask the owner/admin, or create your own copy.`
    );
  }
  const owner = (p.owner && p.owner.trim()) || existing.owner || "-";
  const app = (p.app && p.app.trim()) || existing.app || CONFIG.defaultApp;
  // name is immutable on update; strip it if present.
  const { name: _drop, ...body } = form;
  const res = await postForm(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/saved/searches/${encodeURIComponent(name)}`,
    body
  );
  const entry = Array.isArray(res?.entry) ? res.entry[0] : null;
  return { updated: true, name: entry?.name ?? name, owner, app };
}

/** Create a report. Requires docsConsulted=true. */
export async function createReport(p) {
  assertDocsConsulted(p, "create_report", "classic");
  const form = buildReportForm(p, "create");
  return createSaved(form, p.app);
}

/** Update a report. Access-checked; requires docsConsulted=true. */
export async function updateReport(p) {
  assertDocsConsulted(p, "update_report", "classic");
  const form = buildReportForm(p, "update");
  return updateSaved(p.name, form, p);
}

/** Create an alert. Requires docsConsulted=true. */
export async function createAlert(p) {
  assertDocsConsulted(p, "create_alert", "classic");
  const form = buildAlertForm(p, "create");
  return createSaved(form, p.app);
}

/** Update an alert. Access-checked; requires docsConsulted=true. */
export async function updateAlert(p) {
  assertDocsConsulted(p, "update_alert", "classic");
  const form = buildAlertForm(p, "update");
  return updateSaved(p.name, form, p);
}
