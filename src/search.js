import { postRaw } from "./splunk-rest.js";
import { normalizeSpl, parseExportNdjson } from "./spl.js";

export { normalizeSpl, parseExportNdjson };

/**
 * Run an SPL search and return results.
 *
 * Uses the `search/jobs/export` endpoint (output_mode=json), which streams
 * newline-delimited JSON — one object per line — and finishes without polling.
 * Results run as the logged-in user, so Splunk enforces index/data access.
 *
 * DOCUMENTATION-FIRST: SPL syntax is version-specific. Consult the Splunk Search
 * Reference (see the splunk_docs tool, topic "spl") before composing a query.
 *
 * @param {{ query: string; earliest?: string; latest?: string; maxResults?: number }} p
 */
export async function runSearch(p) {
  const search = normalizeSpl(p.query);
  const count = Math.min(Math.max(1, p.maxResults ?? 100), 10_000);
  const form = {
    search,
    output_mode: "json",
    earliest_time: p.earliest || "-24h@h",
    latest_time: p.latest || "now",
    count: String(count),
  };
  const text = await postRaw("/services/search/jobs/export", form);
  const { results, messages } = parseExportNdjson(text);
  return {
    query: search,
    earliest: form.earliest_time,
    latest: form.latest_time,
    count: results.length,
    results: results.slice(0, count),
    messages,
  };
}
