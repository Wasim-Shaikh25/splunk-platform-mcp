/**
 * Pure form-body builders for Splunk saved searches (reports and alerts).
 * No config/network imports so they are unit-testable in isolation.
 *
 * A "report" is a saved search (optionally scheduled) with no triggering.
 * An "alert" is a scheduled saved search with a trigger condition and optional actions.
 */

/**
 * @param {{ name?: string; search: string; description?: string; cron?: string; earliest?: string; latest?: string; disabled?: boolean }} p
 * @param {"create"|"update"} mode
 * @returns {Record<string,string>}
 */
export function buildReportForm(p, mode) {
  if (!p.search || !String(p.search).trim()) {
    throw new Error(`${mode}_report: search (SPL) is required.`);
  }
  /** @type {Record<string,string>} */
  const form = { search: String(p.search) };
  if (mode === "create") {
    if (!p.name || !String(p.name).trim()) throw new Error("create_report: name is required.");
    form.name = String(p.name);
  }
  if (p.description != null) form.description = String(p.description);
  if (p.cron != null && String(p.cron).trim()) {
    form.is_scheduled = "1";
    form.cron_schedule = String(p.cron);
  }
  if (p.earliest != null) form.dispatch_earliest_time = String(p.earliest);
  if (p.latest != null) form.dispatch_latest_time = String(p.latest);
  form.alert_type = "always"; // a report is explicitly not a triggering alert
  form["alert.track"] = "0";
  if (p.disabled != null) form.disabled = p.disabled ? "1" : "0";
  return form;
}

/**
 * @param {{
 *   name?: string; search: string; description?: string;
 *   cron?: string; earliest?: string; latest?: string;
 *   condition?: string; comparator?: string; threshold?: string|number;
 *   customCondition?: string; actions?: string[]; disabled?: boolean;
 * }} p
 * @param {"create"|"update"} mode
 * @returns {Record<string,string>}
 */
export function buildAlertForm(p, mode) {
  if (!p.search || !String(p.search).trim()) {
    throw new Error(`${mode}_alert: search (SPL) is required.`);
  }
  /** @type {Record<string,string>} */
  const form = { search: String(p.search) };
  if (mode === "create") {
    if (!p.name || !String(p.name).trim()) throw new Error("create_alert: name is required.");
    form.name = String(p.name);
    form.cron_schedule = p.cron ? String(p.cron) : "*/15 * * * *";
  } else if (p.cron != null && String(p.cron).trim()) {
    form.cron_schedule = String(p.cron);
  }

  form.is_scheduled = "1";
  form["alert.track"] = "1";
  if (p.description != null) form.description = String(p.description);
  if (p.earliest != null) form.dispatch_earliest_time = String(p.earliest);
  else if (mode === "create") form.dispatch_earliest_time = "-15m@m";
  if (p.latest != null) form.dispatch_latest_time = String(p.latest);
  else if (mode === "create") form.dispatch_latest_time = "now";

  const condition = p.condition || (mode === "create" ? "number of results" : undefined);
  if (condition === "custom") {
    form.alert_type = "custom";
    if (!p.customCondition || !String(p.customCondition).trim()) {
      throw new Error(`${mode}_alert: customCondition (SPL) is required when condition="custom".`);
    }
    form.alert_condition = String(p.customCondition);
  } else if (condition != null) {
    form.alert_type = condition;
    form.alert_comparator = p.comparator || "greater than";
    form.alert_threshold = p.threshold != null ? String(p.threshold) : "0";
  }

  if (Array.isArray(p.actions) && p.actions.length > 0) {
    form.actions = p.actions.join(", ");
  }
  if (p.disabled != null) form.disabled = p.disabled ? "1" : "0";
  return form;
}
