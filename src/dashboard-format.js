/**
 * Pure format detection for Splunk dashboard definitions.
 * Kept free of config/network imports so it is unit-testable in isolation.
 */

/**
 * Detect Studio (JSON) vs Classic (Simple XML) from a stored `eai:data` definition.
 * @param {unknown} eaiData
 * @returns {"studio" | "classic" | "unknown"}
 */
export function detectFormat(eaiData) {
  const s = typeof eaiData === "string" ? eaiData.trim() : "";
  if (!s) return "unknown";
  if (s.startsWith("{")) return "studio";
  // A versioned envelope (<dashboard version="2"> ... <definition>JSON</definition>)
  // is how splunkd stores a Studio dashboard — classify it as studio, not classic.
  if (/^<dashboard\b[^>]*\bversion\s*=\s*["']2["']/i.test(s) && /<definition\b/i.test(s)) {
    return "studio";
  }
  if (s.startsWith("<")) return "classic";
  // Studio definitions embed a "visualizations" object; Classic uses <dashboard>/<form>.
  if (/"visualizations"\s*:/.test(s)) return "studio";
  if (/<dashboard|<form/i.test(s)) return "classic";
  return "unknown";
}

/** Escape a value for safe inclusion in an XML text/attribute node. */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Produce the `eai:data` string the data/ui/views endpoint stores.
 *
 * - Classic: the Simple XML is stored as-is.
 * - Studio: splunkd stores Studio dashboards as a versioned XML envelope whose
 *   <definition> holds the JSON in a CDATA block. Posting raw JSON yields
 *   "Invalid XML", so we wrap it. If the caller already passed a wrapped
 *   <dashboard version="2"> envelope, it is left untouched.
 *
 * @param {string} definition raw definition (Studio JSON or Classic XML)
 * @param {"studio"|"classic"|"unknown"} format
 * @param {{ label?: string; description?: string }} [meta]
 * @returns {string}
 */
export function toEaiData(definition, format, meta = {}) {
  const raw = String(definition ?? "").trim();
  if (format !== "studio") return raw;
  // Already an envelope? leave it.
  if (/^<dashboard\b[^>]*\bversion\s*=\s*["']2["']/i.test(raw)) return raw;

  let label = meta.label;
  let description = meta.description;
  // Derive label/description from the JSON when not explicitly provided.
  try {
    const parsed = JSON.parse(raw);
    if (label == null && typeof parsed?.title === "string") label = parsed.title;
    if (description == null && typeof parsed?.description === "string") description = parsed.description;
  } catch {
    // definition may not be parseable here; caller-provided meta still applies
  }

  const labelXml = label != null ? `<label>${xmlEscape(label)}</label>` : "";
  const descXml = description != null ? `<description>${xmlEscape(description)}</description>` : "";
  return `<dashboard version="2" theme="light">${labelXml}<definition><![CDATA[${raw}]]></definition>${descXml}</dashboard>`;
}
