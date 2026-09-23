#!/usr/bin/env node
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loginWithSSO, loginToolResultText } from "./auth.js";
import { docsGuidance } from "./docs.js";
import {
  listDashboards,
  getDashboard,
  checkDashboardAccess,
  createDashboard,
  updateDashboard,
  getCurrentUsername,
} from "./dashboards.js";
import { runSearch } from "./search.js";
import {
  listSavedSearches,
  getSavedSearch,
  createReport,
  updateReport,
  createAlert,
  updateAlert,
} from "./saved-searches.js";
import { startCookieKeepAlive } from "./cookie-refresh.js";

const server = new Server(
  { name: "splunk-platform-mcp", version: "0.1.2" },
  { capabilities: { tools: {} } }
);

const DOCS_FIRST =
  " DOCUMENTATION-FIRST: read the official Splunk docs (use the splunk_docs tool) before writing SPL or a dashboard definition; do not guess syntax or schema.";

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "splunk_login",
      description:
        "SSO login in a browser (Playwright); saves cookies for the Splunk REST API. Auth is SSO-cookie only. If IdP redirects or automation block the session, delete the reported cookie file and retry, and complete SSO fully in the opened window.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "splunk_docs",
      description:
        "Return the official Splunk documentation references you MUST consult before authoring SPL or dashboards. Call this first when writing queries or dashboard definitions. Optional topic: spl | studio | classic | rest.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Optional focus: spl, studio, classic, or rest. Omit for all references.",
          },
        },
      },
    },
    {
      name: "whoami",
      description:
        "Show the Splunk username the current session authenticates as. New dashboards are created under this profile.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_dashboards",
      description:
        "List dashboards you can see (Splunk enforces visibility by your account). Filter by app, owner, or a name/label substring. Wildcards: omit app/owner to search all.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App namespace (e.g. search). Omit for all apps." },
          owner: { type: "string", description: "Owner username. Omit for all owners." },
          query: { type: "string", description: "Case-insensitive substring match on name/label." },
          count: { type: "number", description: "Max results (default 50, max 200)." },
        },
      },
    },
    {
      name: "get_dashboard",
      description:
        "Fetch one dashboard's full definition (Dashboard Studio JSON or Classic Simple XML), its app/owner/sharing, detected format, and your can_write flag.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Dashboard (view) name/id." },
          app: { type: "string", description: "App namespace. Default: SPLUNK_DEFAULT_APP (search)." },
          owner: { type: "string", description: "Owner username. Default: any (-)." },
        },
        required: ["name"],
      },
    },
    {
      name: "check_dashboard_access",
      description:
        "Check whether you can edit a dashboard BEFORE trying to update it. Reads the Splunk ACL and reports can_write with a plain-language verdict.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Dashboard (view) name/id." },
          app: { type: "string", description: "App namespace. Default search." },
          owner: { type: "string", description: "Owner username. Default any (-)." },
        },
        required: ["name"],
      },
    },
    {
      name: "create_dashboard",
      description:
        "Create a NEW dashboard under YOUR profile (owner = your Splunk user, private by default). Supports Dashboard Studio (JSON) and Classic (Simple XML). Requires docsConsulted=true." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "New dashboard name/id (unique within the app)." },
          definition: {
            type: "string",
            description: "Full dashboard definition: Studio JSON or Classic Simple XML.",
          },
          format: {
            type: "string",
            description: "studio (JSON) or classic (XML). Auto-detected if omitted.",
          },
          app: { type: "string", description: "App namespace to create in. Default search." },
          label: { type: "string", description: "Optional display label (Studio)." },
          docsConsulted: {
            type: "boolean",
            description: "Must be true — confirms you read the Splunk docs for this format.",
          },
          docsReference: {
            type: "string",
            description: "The doc URL/section you used (recommended for the audit trail).",
          },
        },
        required: ["name", "definition", "docsConsulted"],
      },
    },
    {
      name: "update_dashboard",
      description:
        "Update an EXISTING dashboard's definition. Pre-checks your edit access and REFUSES if Splunk ACL denies write. Requires docsConsulted=true." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Existing dashboard name/id." },
          definition: { type: "string", description: "New full definition (Studio JSON or Classic XML)." },
          format: { type: "string", description: "studio or classic. Auto-detected if omitted." },
          app: { type: "string", description: "App namespace. Default: the dashboard's current app." },
          owner: { type: "string", description: "Owner namespace. Default: the dashboard's current owner." },
          docsConsulted: {
            type: "boolean",
            description: "Must be true — confirms you read the Splunk docs for this format.",
          },
          docsReference: { type: "string", description: "The doc URL/section you used." },
        },
        required: ["name", "definition", "docsConsulted"],
      },
    },
    {
      name: "query_splunk",
      description:
        "Run an SPL search and return results (runs as you; Splunk enforces data access). Use the splunk_docs tool (topic 'spl') to verify command syntax before composing queries." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "SPL query. A bare term expression is auto-prefixed with 'search'.",
          },
          earliest: { type: "string", description: "Earliest time (e.g. -24h@h, -7d, 0). Default -24h@h." },
          latest: { type: "string", description: "Latest time (e.g. now). Default now." },
          maxResults: { type: "number", description: "Max results (default 100, max 10000)." },
        },
        required: ["query"],
      },
    },
    {
      name: "list_reports",
      description:
        "List saved searches classified as reports (not alerts) that you can see. Filter by app/owner/name.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App namespace. Omit for all." },
          owner: { type: "string", description: "Owner username. Omit for all." },
          query: { type: "string", description: "Case-insensitive substring match on name." },
          count: { type: "number", description: "Max results (default 50, max 200)." },
        },
      },
    },
    {
      name: "get_report",
      description: "Get one report (saved search): its SPL, schedule, ACL, and full config.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Report (saved search) name." },
          app: { type: "string", description: "App namespace. Default search." },
          owner: { type: "string", description: "Owner username. Default any (-)." },
        },
        required: ["name"],
      },
    },
    {
      name: "create_report",
      description:
        "Create a report (saved search) under YOUR profile. Optionally scheduled via cron. Requires docsConsulted=true." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "New report name (unique within the app)." },
          search: { type: "string", description: "SPL for the report." },
          description: { type: "string", description: "Optional description." },
          cron: { type: "string", description: "Optional cron schedule (e.g. '0 6 * * 1'). Sets is_scheduled." },
          earliest: { type: "string", description: "Dispatch earliest time (e.g. -7d@d)." },
          latest: { type: "string", description: "Dispatch latest time (e.g. now)." },
          app: { type: "string", description: "App namespace to create in. Default search." },
          docsConsulted: { type: "boolean", description: "Must be true — confirms docs consulted." },
          docsReference: { type: "string", description: "The doc URL/section you used." },
        },
        required: ["name", "search", "docsConsulted"],
      },
    },
    {
      name: "update_report",
      description:
        "Update an existing report. Pre-checks edit access; refuses if can_write is false. Requires docsConsulted=true." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Existing report name." },
          search: { type: "string", description: "New SPL." },
          description: { type: "string", description: "Optional description." },
          cron: { type: "string", description: "Optional cron schedule." },
          earliest: { type: "string", description: "Dispatch earliest time." },
          latest: { type: "string", description: "Dispatch latest time." },
          app: { type: "string", description: "App namespace. Default: the report's current app." },
          owner: { type: "string", description: "Owner. Default: the report's current owner." },
          docsConsulted: { type: "boolean", description: "Must be true." },
          docsReference: { type: "string", description: "The doc URL/section you used." },
        },
        required: ["name", "search", "docsConsulted"],
      },
    },
    {
      name: "list_alerts",
      description: "List saved searches classified as alerts (scheduled + triggering) that you can see.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App namespace. Omit for all." },
          owner: { type: "string", description: "Owner username. Omit for all." },
          query: { type: "string", description: "Case-insensitive substring match on name." },
          count: { type: "number", description: "Max results (default 50, max 200)." },
        },
      },
    },
    {
      name: "get_alert",
      description: "Get one alert (saved search with alerting): SPL, schedule, trigger condition, actions, ACL.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Alert (saved search) name." },
          app: { type: "string", description: "App namespace. Default search." },
          owner: { type: "string", description: "Owner username. Default any (-)." },
        },
        required: ["name"],
      },
    },
    {
      name: "create_alert",
      description:
        "Create an alert (scheduled saved search with a trigger condition) under YOUR profile. Requires docsConsulted=true." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "New alert name." },
          search: { type: "string", description: "SPL for the alert." },
          description: { type: "string", description: "Optional description." },
          cron: { type: "string", description: "Cron schedule. Default '*/15 * * * *'." },
          earliest: { type: "string", description: "Dispatch earliest time. Default -15m@m." },
          latest: { type: "string", description: "Dispatch latest time. Default now." },
          condition: {
            type: "string",
            description:
              "Trigger: 'number of results' | 'number of hosts' | 'number of sources' | 'custom'. Default 'number of results'.",
          },
          comparator: {
            type: "string",
            description: "For non-custom: 'greater than' | 'less than' | 'equal to' | 'not equal to' | 'rises by' | 'drops by'. Default 'greater than'.",
          },
          threshold: { type: "string", description: "For non-custom: numeric threshold. Default '0'." },
          customCondition: { type: "string", description: "For condition='custom': the SPL condition." },
          actions: {
            type: "array",
            items: { type: "string" },
            description: "Optional alert actions (e.g. 'email', 'webhook'). Configure action params in Splunk UI.",
          },
          app: { type: "string", description: "App namespace. Default search." },
          docsConsulted: { type: "boolean", description: "Must be true." },
          docsReference: { type: "string", description: "The doc URL/section you used." },
        },
        required: ["name", "search", "docsConsulted"],
      },
    },
    {
      name: "update_alert",
      description:
        "Update an existing alert. Pre-checks edit access; refuses if can_write is false. Requires docsConsulted=true." +
        DOCS_FIRST,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Existing alert name." },
          search: { type: "string", description: "New SPL." },
          description: { type: "string", description: "Optional description." },
          cron: { type: "string", description: "Cron schedule." },
          earliest: { type: "string", description: "Dispatch earliest time." },
          latest: { type: "string", description: "Dispatch latest time." },
          condition: { type: "string", description: "Trigger type (see create_alert)." },
          comparator: { type: "string", description: "Comparator (see create_alert)." },
          threshold: { type: "string", description: "Numeric threshold." },
          customCondition: { type: "string", description: "SPL condition for condition='custom'." },
          actions: { type: "array", items: { type: "string" }, description: "Alert actions." },
          app: { type: "string", description: "App namespace. Default: the alert's current app." },
          owner: { type: "string", description: "Owner. Default: the alert's current owner." },
          docsConsulted: { type: "boolean", description: "Must be true." },
          docsReference: { type: "string", description: "The doc URL/section you used." },
        },
        required: ["name", "search", "docsConsulted"],
      },
    },
  ],
}));

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  if (name === "splunk_login") {
    const result = await loginWithSSO();
    return { content: [{ type: "text", text: loginToolResultText(result) }] };
  }

  if (name === "splunk_docs") {
    return textResult(docsGuidance(args.topic != null ? String(args.topic) : undefined));
  }

  if (name === "whoami") {
    const username = await getCurrentUsername();
    return textResult({ username });
  }

  if (name === "list_dashboards") {
    const data = await listDashboards({
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
      query: args.query != null ? String(args.query) : undefined,
      count: typeof args.count === "number" ? args.count : undefined,
    });
    return textResult(data);
  }

  if (name === "get_dashboard") {
    const data = await getDashboard({
      name: String(args.name),
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
    });
    return textResult(data);
  }

  if (name === "check_dashboard_access") {
    const data = await checkDashboardAccess({
      name: String(args.name),
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
    });
    return textResult(data);
  }

  if (name === "create_dashboard") {
    const data = await createDashboard({
      name: String(args.name),
      definition: String(args.definition),
      format: args.format != null ? String(args.format) : undefined,
      app: args.app != null ? String(args.app) : undefined,
      label: args.label != null ? String(args.label) : undefined,
      docsConsulted: args.docsConsulted === true,
      docsReference: args.docsReference != null ? String(args.docsReference) : undefined,
    });
    return textResult(data);
  }

  if (name === "update_dashboard") {
    const data = await updateDashboard({
      name: String(args.name),
      definition: String(args.definition),
      format: args.format != null ? String(args.format) : undefined,
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
      label: args.label != null ? String(args.label) : undefined,
      docsConsulted: args.docsConsulted === true,
      docsReference: args.docsReference != null ? String(args.docsReference) : undefined,
    });
    return textResult(data);
  }

  if (name === "query_splunk") {
    const data = await runSearch({
      query: String(args.query),
      earliest: args.earliest != null ? String(args.earliest) : undefined,
      latest: args.latest != null ? String(args.latest) : undefined,
      maxResults: typeof args.maxResults === "number" ? args.maxResults : undefined,
    });
    return textResult(data);
  }

  if (name === "list_reports" || name === "list_alerts") {
    const data = await listSavedSearches({
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
      query: args.query != null ? String(args.query) : undefined,
      kind: name === "list_alerts" ? "alert" : "report",
      count: typeof args.count === "number" ? args.count : undefined,
    });
    return textResult(data);
  }

  if (name === "get_report" || name === "get_alert") {
    const data = await getSavedSearch({
      name: String(args.name),
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
    });
    return textResult(data);
  }

  if (name === "create_report") {
    const data = await createReport({
      name: String(args.name),
      search: String(args.search),
      description: args.description != null ? String(args.description) : undefined,
      cron: args.cron != null ? String(args.cron) : undefined,
      earliest: args.earliest != null ? String(args.earliest) : undefined,
      latest: args.latest != null ? String(args.latest) : undefined,
      app: args.app != null ? String(args.app) : undefined,
      docsConsulted: args.docsConsulted === true,
      docsReference: args.docsReference != null ? String(args.docsReference) : undefined,
    });
    return textResult(data);
  }

  if (name === "update_report") {
    const data = await updateReport({
      name: String(args.name),
      search: String(args.search),
      description: args.description != null ? String(args.description) : undefined,
      cron: args.cron != null ? String(args.cron) : undefined,
      earliest: args.earliest != null ? String(args.earliest) : undefined,
      latest: args.latest != null ? String(args.latest) : undefined,
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
      docsConsulted: args.docsConsulted === true,
      docsReference: args.docsReference != null ? String(args.docsReference) : undefined,
    });
    return textResult(data);
  }

  if (name === "create_alert") {
    const data = await createAlert({
      name: String(args.name),
      search: String(args.search),
      description: args.description != null ? String(args.description) : undefined,
      cron: args.cron != null ? String(args.cron) : undefined,
      earliest: args.earliest != null ? String(args.earliest) : undefined,
      latest: args.latest != null ? String(args.latest) : undefined,
      condition: args.condition != null ? String(args.condition) : undefined,
      comparator: args.comparator != null ? String(args.comparator) : undefined,
      threshold: args.threshold != null ? String(args.threshold) : undefined,
      customCondition: args.customCondition != null ? String(args.customCondition) : undefined,
      actions: Array.isArray(args.actions) ? args.actions.map(String) : undefined,
      app: args.app != null ? String(args.app) : undefined,
      docsConsulted: args.docsConsulted === true,
      docsReference: args.docsReference != null ? String(args.docsReference) : undefined,
    });
    return textResult(data);
  }

  if (name === "update_alert") {
    const data = await updateAlert({
      name: String(args.name),
      search: String(args.search),
      description: args.description != null ? String(args.description) : undefined,
      cron: args.cron != null ? String(args.cron) : undefined,
      earliest: args.earliest != null ? String(args.earliest) : undefined,
      latest: args.latest != null ? String(args.latest) : undefined,
      condition: args.condition != null ? String(args.condition) : undefined,
      comparator: args.comparator != null ? String(args.comparator) : undefined,
      threshold: args.threshold != null ? String(args.threshold) : undefined,
      customCondition: args.customCondition != null ? String(args.customCondition) : undefined,
      actions: Array.isArray(args.actions) ? args.actions.map(String) : undefined,
      app: args.app != null ? String(args.app) : undefined,
      owner: args.owner != null ? String(args.owner) : undefined,
      docsConsulted: args.docsConsulted === true,
      docsReference: args.docsReference != null ? String(args.docsReference) : undefined,
    });
    return textResult(data);
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Keep the Splunk session warm and warn early if the SSO cookie goes stale.
startCookieKeepAlive();

process.on("SIGINT", async () => {
  await transport.close();
  process.exit(0);
});
