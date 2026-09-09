import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReportForm, buildAlertForm } from "../src/saved-search-format.js";
import { normalizeSpl, parseExportNdjson } from "../src/spl.js";
import { docsGuidance } from "../src/docs.js";

test("buildReportForm: create requires name and search", () => {
  assert.throws(() => buildReportForm({ search: "index=_internal" }, "create"), /name is required/);
  assert.throws(() => buildReportForm({ name: "r" }, "create"), /search .* is required/);
  const f = buildReportForm({ name: "r", search: "index=_internal", cron: "0 6 * * 1" }, "create");
  assert.equal(f.name, "r");
  assert.equal(f.search, "index=_internal");
  assert.equal(f.is_scheduled, "1");
  assert.equal(f.cron_schedule, "0 6 * * 1");
  assert.equal(f.alert_type, "always");
});

test("buildReportForm: update omits name", () => {
  const f = buildReportForm({ name: "ignored-on-update", search: "index=x" }, "update");
  // name is only added on create
  assert.equal(f.name, undefined);
  assert.equal(f.search, "index=x");
});

test("buildAlertForm: create sets schedule + default trigger", () => {
  const f = buildAlertForm({ name: "a", search: "index=x error" }, "create");
  assert.equal(f.name, "a");
  assert.equal(f.is_scheduled, "1");
  assert.equal(f["alert.track"], "1");
  assert.equal(f.alert_type, "number of results");
  assert.equal(f.alert_comparator, "greater than");
  assert.equal(f.alert_threshold, "0");
  assert.ok(f.cron_schedule);
});

test("buildAlertForm: custom condition requires customCondition", () => {
  assert.throws(
    () => buildAlertForm({ name: "a", search: "index=x", condition: "custom" }, "create"),
    /customCondition .* required/
  );
  const f = buildAlertForm(
    { name: "a", search: "index=x", condition: "custom", customCondition: "search count > 5" },
    "create"
  );
  assert.equal(f.alert_type, "custom");
  assert.equal(f.alert_condition, "search count > 5");
});

test("buildAlertForm: actions joined", () => {
  const f = buildAlertForm(
    { name: "a", search: "index=x", actions: ["email", "webhook"] },
    "create"
  );
  assert.equal(f.actions, "email, webhook");
});

test("normalizeSpl: prefixes bare terms, leaves search/pipe alone", () => {
  assert.equal(normalizeSpl("index=_internal error"), "search index=_internal error");
  assert.equal(normalizeSpl("search index=x"), "search index=x");
  assert.equal(normalizeSpl("| tstats count"), "| tstats count");
  assert.throws(() => normalizeSpl("   "), /required/);
});

test("parseExportNdjson: extracts results and messages", () => {
  const nd = [
    JSON.stringify({ result: { _time: "t1", host: "h1" } }),
    JSON.stringify({ result: { _time: "t2", host: "h2" } }),
    JSON.stringify({ messages: [{ type: "INFO", text: "done" }] }),
    "not json",
    "",
  ].join("\n");
  const { results, messages } = parseExportNdjson(nd);
  assert.equal(results.length, 2);
  assert.equal(results[0].host, "h1");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "done");
});

test("docsGuidance: report and alert topics resolve", () => {
  for (const topic of ["report", "alert"]) {
    const g = docsGuidance(topic);
    assert.ok(g.references.length > 0);
    for (const r of g.references) assert.ok(r.url.startsWith("https://docs.splunk.com/"));
  }
});
