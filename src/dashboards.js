import { CONFIG } from "./config.js";
import { getJson, postForm } from "./splunk-rest.js";
import { assertDocsConsulted } from "./docs.js";
import { detectFormat, toEaiData } from "./dashboard-format.js";

export { detectFormat };

/**
 * Dashboard operations over the Splunk `data/ui/views` endpoint.
 *
 * Identity model: every call runs as the logged-in user (SSO cookie or token), so
 * Splunk's own ACLs decide what is visible and writable. We surface those ACLs and
 * pre-check `can_write` before an update, and we always create under the user's own
 * owner namespace so new dashboards belong to the caller's profile.
 */

let cachedUsername = null;

/** The username Splunk sees for the current session (used as create owner). */
export async function getCurrentUsername() {
  if (CONFIG.ownerOverride) return CONFIG.ownerOverride;
  if (cachedUsername) return cachedUsername;
  const data = await getJson("/services/authentication/current-context?count=1");
  const entry = Array.isArray(data?.entry) ? data.entry[0] : null;
  const username = entry?.content?.username || entry?.name;
  if (!username) {
    throw new Error("Could not resolve current Splunk username from current-context.");
  }
  cachedUsername = username;
  return username;
}

function summarizeView(entry) {
  const acl = entry?.acl ?? {};
  const content = entry?.content ?? {};
  return {
    name: entry?.name,
    label: content?.label ?? null,
    app: acl?.app ?? null,
    owner: acl?.owner ?? null,
    sharing: acl?.sharing ?? null,
    isDashboard: content?.isDashboard,
    canWrite: acl?.can_write === true || acl?.perms == null ? acl?.can_write ?? null : acl?.can_write,
    canChangePerms: acl?.can_change_perms ?? null,
  };
}

/**
 * List dashboards the current user can see. Optional filters narrow by app, owner,
 * or a name/label substring. Wildcards (`-`) mean "all apps / all owners".
 * @param {{ app?: string; owner?: string; query?: string; count?: number }} [p]
 */
export async function listDashboards(p = {}) {
  const app = (p.app && p.app.trim()) || "-";
  const owner = (p.owner && p.owner.trim()) || "-";
  const count = Math.min(Math.max(1, p.count ?? 50), 200);
  const params = new URLSearchParams({
    count: String(count),
    sort_mode: "natural",
    search: "isDashboard=1",
  });
  const data = await getJson(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views?${params.toString()}`
  );
  const entries = Array.isArray(data?.entry) ? data.entry : [];
  let views = entries.map(summarizeView);
  if (p.query && p.query.trim()) {
    const q = p.query.trim().toLowerCase();
    views = views.filter(
      (v) =>
        (v.name && v.name.toLowerCase().includes(q)) ||
        (v.label && String(v.label).toLowerCase().includes(q))
    );
  }
  return { total: views.length, views };
}

/**
 * Get one dashboard's full definition + ACL + detected format.
 * @param {{ name: string; app?: string; owner?: string }} p
 */
export async function getDashboard(p) {
  const name = p.name;
  if (!name) throw new Error("get_dashboard: name is required.");
  const app = (p.app && p.app.trim()) || CONFIG.defaultApp;
  const owner = (p.owner && p.owner.trim()) || "-";
  const data = await getJson(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(name)}`
  );
  const entry = Array.isArray(data?.entry) ? data.entry[0] : null;
  if (!entry) throw new Error(`get_dashboard: no view named "${name}" in app "${app}".`);
  const eaiData = entry?.content?.["eai:data"] ?? "";
  const acl = entry?.acl ?? {};
  return {
    name: entry?.name,
    label: entry?.content?.label ?? null,
    app: acl?.app ?? app,
    owner: acl?.owner ?? null,
    sharing: acl?.sharing ?? null,
    format: detectFormat(eaiData),
    canWrite: acl?.can_write ?? null,
    canChangePerms: acl?.can_change_perms ?? null,
    definition: eaiData,
  };
}

/**
 * Report whether the current user can edit a given dashboard (reads its ACL).
 * @param {{ name: string; app?: string; owner?: string }} p
 */
export async function checkDashboardAccess(p) {
  const d = await getDashboard(p);
  const me = await getCurrentUsername().catch(() => null);
  return {
    name: d.name,
    app: d.app,
    owner: d.owner,
    sharing: d.sharing,
    currentUser: me,
    canWrite: d.canWrite,
    canChangePerms: d.canChangePerms,
    verdict:
      d.canWrite === true
        ? "You can edit this dashboard."
        : d.canWrite === false
          ? "You do NOT have edit access to this dashboard (Splunk ACL denies write)."
          : "Edit access is unknown from the ACL; the update will still be attempted and Splunk will enforce permissions.",
  };
}

/**
 * Create a dashboard under the current user's own namespace (their profile).
 * Requires docsConsulted=true (documentation-first policy).
 * @param {{ name: string; definition: string; label?: string; app?: string; format?: "studio"|"classic"; docsConsulted?: boolean; docsReference?: string }} p
 */
export async function createDashboard(p) {
  const name = p.name;
  if (!name) throw new Error("create_dashboard: name is required.");
  if (!p.definition || !String(p.definition).trim()) {
    throw new Error("create_dashboard: definition is required (Studio JSON or Classic Simple XML).");
  }
  const format = p.format || detectFormat(p.definition);
  if (format === "unknown") {
    throw new Error(
      "create_dashboard: could not detect format. Pass format='studio' (JSON) or 'classic' (XML)."
    );
  }
  assertDocsConsulted(p, "create_dashboard", format);

  const owner = await getCurrentUsername();
  const app = (p.app && p.app.trim()) || CONFIG.defaultApp;

  // Studio JSON is wrapped in the versioned XML envelope splunkd stores; Classic XML
  // is sent as-is. See toEaiData / the RESTusage docs.
  const eaiData = toEaiData(p.definition, format, { label: p.label });
  const form = { name, "eai:data": eaiData };
  const created = await postForm(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views`,
    form
  );
  const entry = Array.isArray(created?.entry) ? created.entry[0] : null;
  return {
    created: true,
    name: entry?.name ?? name,
    owner: entry?.acl?.owner ?? owner,
    app: entry?.acl?.app ?? app,
    format,
    docsReference: p.docsReference ?? null,
    note: "Created under your profile (private). Adjust sharing in Splunk if others need access.",
  };
}

/**
 * Update an existing dashboard's definition. Pre-checks edit access and refuses if
 * the ACL denies write. Requires docsConsulted=true.
 * @param {{ name: string; definition: string; app?: string; owner?: string; label?: string; format?: "studio"|"classic"; docsConsulted?: boolean; docsReference?: string }} p
 */
export async function updateDashboard(p) {
  const name = p.name;
  if (!name) throw new Error("update_dashboard: name is required.");
  if (!p.definition || !String(p.definition).trim()) {
    throw new Error("update_dashboard: definition is required.");
  }

  // Read current state: confirms existence, detects format, and gives us the ACL.
  const current = await getDashboard({ name, app: p.app, owner: p.owner });
  const format = p.format || detectFormat(p.definition) || current.format;
  assertDocsConsulted(p, "update_dashboard", format === "unknown" ? "studio" : format);

  if (current.canWrite === false) {
    throw new Error(
      `update_dashboard refused: you do not have edit access to "${name}" ` +
        `(app="${current.app}", owner="${current.owner}", sharing="${current.sharing}"). ` +
        `Splunk ACL reports can_write=false. Ask the owner/admin for access, or create your own copy with create_dashboard.`
    );
  }

  const owner = (p.owner && p.owner.trim()) || current.owner || "-";
  const app = (p.app && p.app.trim()) || current.app || CONFIG.defaultApp;
  const eaiData = toEaiData(p.definition, format === "unknown" ? current.format : format, {
    label: p.label,
  });
  const updated = await postForm(
    `/servicesNS/${encodeURIComponent(owner)}/${encodeURIComponent(app)}/data/ui/views/${encodeURIComponent(name)}`,
    { "eai:data": eaiData }
  );
  const entry = Array.isArray(updated?.entry) ? updated.entry[0] : null;
  return {
    updated: true,
    name: entry?.name ?? name,
    owner: entry?.acl?.owner ?? owner,
    app: entry?.acl?.app ?? app,
    format: format === "unknown" ? current.format : format,
    docsReference: p.docsReference ?? null,
  };
}

