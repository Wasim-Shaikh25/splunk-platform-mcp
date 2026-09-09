import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, toEaiData } from "../src/dashboard-format.js";
import { docsGuidance, assertDocsConsulted, SPLUNK_DOCS } from "../src/docs.js";

test("detectFormat: Studio JSON", () => {
  assert.equal(detectFormat('{"visualizations": {}, "dataSources": {}}'), "studio");
  assert.equal(detectFormat("  {\n  \"title\": \"x\" }"), "studio");
});

test("detectFormat: Classic Simple XML", () => {
  assert.equal(detectFormat("<dashboard><label>x</label></dashboard>"), "classic");
  assert.equal(detectFormat("<form version=\"1.1\"></form>"), "classic");
});

test("detectFormat: Studio stored as versioned XML envelope", () => {
  const stored =
    '<dashboard version="2" theme="light"><label>x</label><definition><![CDATA[{"visualizations":{}}]]></definition></dashboard>';
  assert.equal(detectFormat(stored), "studio");
});

test("toEaiData: wraps Studio JSON, passes Classic through", () => {
  const json = '{"visualizations":{},"title":"T","description":"D"}';
  const wrapped = toEaiData(json, "studio");
  assert.match(wrapped, /^<dashboard version="2"/);
  assert.match(wrapped, /<!\[CDATA\[/);
  assert.match(wrapped, /<label>T<\/label>/);
  // Already-wrapped envelope is not double-wrapped.
  assert.equal(toEaiData(wrapped, "studio"), wrapped);
  // Classic passes through untouched.
  const xml = "<dashboard><label>x</label></dashboard>";
  assert.equal(toEaiData(xml, "classic"), xml);
});

test("detectFormat: unknown/empty", () => {
  assert.equal(detectFormat(""), "unknown");
  assert.equal(detectFormat(null), "unknown");
  assert.equal(detectFormat("plain text"), "unknown");
});

test("docsGuidance returns references for each topic", () => {
  for (const topic of ["spl", "studio", "classic", "rest", "anything"]) {
    const g = docsGuidance(topic);
    assert.ok(Array.isArray(g.references) && g.references.length > 0);
    for (const r of g.references) {
      assert.ok(r.url.startsWith("https://docs.splunk.com/"));
    }
  }
});

test("all SPLUNK_DOCS entries point at docs.splunk.com", () => {
  for (const v of Object.values(SPLUNK_DOCS)) {
    assert.ok(v.url.startsWith("https://docs.splunk.com/"), v.url);
  }
});

test("assertDocsConsulted throws without docsConsulted, passes with it", () => {
  assert.throws(() => assertDocsConsulted({}, "create_dashboard", "studio"), /documentation-first/i);
  assert.throws(
    () => assertDocsConsulted({ docsConsulted: false }, "update_dashboard", "classic"),
    /documentation-first/i
  );
  assert.doesNotThrow(() => assertDocsConsulted({ docsConsulted: true }, "create_dashboard", "studio"));
});
