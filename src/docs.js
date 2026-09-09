/**
 * Documentation-first gate.
 *
 * Policy: any agent using this MCP MUST consult the official Splunk documentation
 * before authoring SPL or a dashboard definition. The write tools (create/update)
 * require the caller to pass `docsConsulted: true` (and ideally a `docsReference`),
 * which is a machine-checkable acknowledgement that the docs step happened. This
 * exists to protect accuracy — SPL syntax, Dashboard Studio schema, and Simple XML
 * all have version-specific rules that must not be guessed.
 */

/** Canonical, stable Splunk documentation entry points, grouped by topic. */
export const SPLUNK_DOCS = {
  spl: {
    title: "Search Reference (SPL commands, functions, syntax)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/WhatsInThisManual",
  },
  splCommands: {
    title: "SPL command quick reference",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/SearchReference/ListOfSearchCommands",
  },
  dashboardStudio: {
    title: "Dashboard Studio manual (JSON definition model)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/DashStudio/AboutDashStudio",
  },
  dashboardStudioSchema: {
    title: "Dashboard Studio dashboard definition (source schema)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/DashStudio/dashDefine",
  },
  dashboardStudioRest: {
    title: "Create a dashboard using REST API endpoints (data/ui/views)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/DashStudio/RESTusage",
  },
  classicXml: {
    title: "Dashboards and Visualizations — Simple XML reference",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/Viz/PanelreferenceforSimplifiedXML",
  },
  restApi: {
    title: "REST API Reference — knowledge endpoints (data/ui/views, saved/searches)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/RESTREF/RESTknowledge",
  },
  savedSearches: {
    title: "Reports & saved searches (create, schedule, saved/searches endpoint)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/Report/Createandeditreports",
  },
  alerting: {
    title: "Alerting manual (alert types, trigger conditions, throttling, actions)",
    url: "https://docs.splunk.com/Documentation/Splunk/latest/Alert/Aboutalerts",
  },
};

/**
 * Human-readable guidance returned by the `splunk_docs` tool.
 * @param {string} [topic]
 */
export function docsGuidance(topic) {
  const key = String(topic || "").trim().toLowerCase();
  const pick = (() => {
    if (["spl", "search", "query"].includes(key)) return ["spl", "splCommands", "restApi"];
    if (["studio", "dashboard-studio", "json"].includes(key)) {
      return ["dashboardStudio", "dashboardStudioSchema", "dashboardStudioRest"];
    }
    if (["classic", "xml", "simplexml", "simple-xml"].includes(key)) return ["classicXml", "restApi"];
    if (["report", "reports", "savedsearch", "saved-search"].includes(key)) {
      return ["spl", "savedSearches", "restApi"];
    }
    if (["alert", "alerts", "alerting"].includes(key)) return ["alerting", "savedSearches", "spl"];
    if (["rest", "api"].includes(key)) return ["restApi", "dashboardStudioRest"];
    return Object.keys(SPLUNK_DOCS);
  })();

  return {
    policy:
      "Documentation-first is mandatory. Before writing SPL or a dashboard definition, read the relevant official Splunk docs below and confirm command syntax, function signatures, and the dashboard schema for your target format. Do not guess SPL or schema fields.",
    topic: key || "all",
    references: pick.map((k) => ({ key: k, title: SPLUNK_DOCS[k].title, url: SPLUNK_DOCS[k].url })),
    onWrite:
      "When calling create_dashboard / update_dashboard, pass docsConsulted=true and a docsReference (the doc URL or section you used). The write is refused without docsConsulted=true.",
  };
}

/** Map an operation/format hint to the docs topic used for its guidance. */
function topicForGate(operation, formatOrKind) {
  if (/report/.test(operation)) return "report";
  if (/alert/.test(operation)) return "alert";
  if (formatOrKind === "studio") return "studio";
  if (formatOrKind === "classic") return "classic";
  return formatOrKind || "all";
}

/**
 * Enforce the docs-first acknowledgement on write operations.
 * @param {{ docsConsulted?: boolean; docsReference?: string }} args
 * @param {string} operation e.g. create_dashboard, update_report, create_alert
 * @param {string} formatOrKind e.g. studio, classic, report, alert
 */
export function assertDocsConsulted(args, operation, formatOrKind) {
  const consulted = args?.docsConsulted === true;
  if (consulted) return;
  const topic = topicForGate(operation, formatOrKind);
  const refs = docsGuidance(topic).references;
  const list = refs.map((r) => `  - ${r.title}: ${r.url}`).join("\n");
  throw new Error(
    `${operation} refused: documentation-first policy not satisfied.\n` +
      `Read the official Splunk docs (topic: ${topic}), then retry with docsConsulted=true and a docsReference.\n` +
      `Relevant docs:\n${list}\n` +
      `(Call the splunk_docs tool for the full list.)`
  );
}
