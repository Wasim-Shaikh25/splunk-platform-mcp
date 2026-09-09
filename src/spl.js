/**
 * Pure SPL helpers (no config/network imports) so they are unit-testable.
 */

/**
 * Splunk export requires a leading `search` for a bare search, but not for a query
 * that already starts with `search` or a generating command (`|`). Only prepend when
 * it's clearly a bare term expression.
 * @param {string} q
 */
export function normalizeSpl(q) {
  const s = String(q || "").trim();
  if (!s) throw new Error("query_splunk: query is required.");
  if (s.startsWith("|") || /^search\b/i.test(s)) return s;
  return `search ${s}`;
}

/**
 * Parse the NDJSON body from search/jobs/export into results + messages.
 * @param {string} text
 */
export function parseExportNdjson(text) {
  const results = [];
  const messages = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (obj.result) results.push(obj.result);
    else if (obj.messages && Array.isArray(obj.messages)) messages.push(...obj.messages);
    else if (obj.type && obj.text) messages.push(obj);
  }
  return { results, messages };
}
