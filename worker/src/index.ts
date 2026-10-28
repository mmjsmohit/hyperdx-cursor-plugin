import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
  TOOL_DESCRIPTIONS,
  createHyperdxClient,
  redactSecret,
} from "../../shared/hyperdx.mjs";
import {
  allowedHostnames,
  authenticate,
  corsHeaders,
  corsOriginHostnames,
  type AuthProps,
  type Env,
} from "./auth";

const SERVER_NAME = "hyperdx";
const VERSION = "0.2.0";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: true,
};

const WINDOW_SCHEMA = {
  last: z
    .string()
    .max(16)
    .optional()
    .describe("Relative window ending now/at end: 15m, 2h, 1d. Default 1h."),
  start: z.string().max(64).optional().describe("ISO start (overrides last)."),
  end: z.string().max(64).optional().describe("ISO end (default now)."),
};

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }],
  };
}

function toolError(error: unknown, apiKey: string) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: redactSecret(message, apiKey) }],
  };
}

async function runTool(fn: () => Promise<unknown>, apiKey: string) {
  try {
    return textResult(await fn());
  } catch (error) {
    return toolError(error, apiKey);
  }
}

function createServer(props: AuthProps) {
  const client = createHyperdxClient({
    apiKey: props.apiKey,
    baseUrl: props.baseUrl,
    userAgent: `hyperdx-mcp-worker/${VERSION}`,
  });

  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

  server.registerTool(
    "find_error_groups",
    {
      description: TOOL_DESCRIPTIONS.find_error_groups,
      inputSchema: z.object({
        query: z
          .string()
          .max(4000)
          .optional()
          .describe("HyperDX search syntax, e.g. level:error service:api. Default level:error."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max groups to return (default 50)."),
        ...WINDOW_SCHEMA,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runTool(() => client.findErrorGroups(args), props.apiKey),
  );

  server.registerTool(
    "get_trace",
    {
      description: TOOL_DESCRIPTIONS.get_trace,
      inputSchema: z.object({
        trace_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Trace id from find_error_groups or a log line."),
        last: z
          .string()
          .max(16)
          .optional()
          .describe("Window to search (default 1d)."),
        start: WINDOW_SCHEMA.start,
        end: WINDOW_SCHEMA.end,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runTool(() => client.getTrace(args), props.apiKey),
  );

  server.registerTool(
    "event_series",
    {
      description: TOOL_DESCRIPTIONS.event_series,
      inputSchema: z.object({
        query: z
          .string()
          .max(4000)
          .optional()
          .describe("Where clause, e.g. level:error service:api."),
        aggFn: z
          .enum(["count", "avg", "sum", "min", "max", "p50", "p90", "p95", "p99", "count_distinct"])
          .optional()
          .describe("Aggregation (default count)."),
        field: z
          .string()
          .max(128)
          .optional()
          .describe("Numeric field for avg/sum/min/max/p50.../count_distinct."),
        groupBy: z
          .array(z.string().max(64))
          .max(5)
          .optional()
          .describe('Up to 5 fields, e.g. ["service"].'),
        granularity: z
          .string()
          .max(32)
          .optional()
          .describe('Bucket size: "1 minute", "5 minute", "1 hour", or "auto". Default "5 minute".'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max points to return (default 5000)."),
        ...WINDOW_SCHEMA,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runTool(() => client.eventSeries(args), props.apiKey),
  );

  server.registerTool(
    "list_services",
    {
      description: TOOL_DESCRIPTIONS.list_services,
      inputSchema: z.object({ ...WINDOW_SCHEMA }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runTool(() => client.listServices(args), props.apiKey),
  );

  server.registerTool(
    "list_alerts",
    {
      description: TOOL_DESCRIPTIONS.list_alerts,
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => runTool(() => client.listAlerts(), props.apiKey),
  );

  server.registerTool(
    "list_dashboards",
    {
      description: TOOL_DESCRIPTIONS.list_dashboards,
      inputSchema: z.object({
        name: z.string().max(200).optional().describe("Case-insensitive dashboard name filter."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max dashboards to return (default 200)."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runTool(() => client.listDashboards(args), props.apiKey),
  );

  server.registerTool(
    "list_metrics",
    {
      description: TOOL_DESCRIPTIONS.list_metrics,
      inputSchema: z.object({
        name: z.string().max(200).optional().describe("Case-insensitive metric name filter."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Max metrics to return (default 200)."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => runTool(() => client.listMetrics(args), props.apiKey),
  );

  return server;
}

function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");

  if (response.status === 204 || response.status === 304) {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function infoResponse(request: Request, env: Env): Response {
  const origin = new URL(request.url).origin;
  const headers = corsHeaders(request, env);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");

  return Response.json(
    {
      name: SERVER_NAME,
      version: VERSION,
      description: "Read-only HyperDX context for root-cause analysis and coding.",
      transport: "streamable-http",
      endpoint: `${origin}/mcp`,
      authentication: {
        per_user_key:
          'Send "Authorization: Bearer <HYPERDX_API_KEY>" or "X-HyperDX-Api-Key: <HYPERDX_API_KEY>".',
        access_gate: env.MCP_ACCESS_TOKEN?.trim()
          ? 'This deployment also requires "X-MCP-Access-Token".'
          : "No shared access gate configured.",
        self_hosted:
          'Optional "X-HyperDX-Api-Url" is accepted only for hostnames in HYPERDX_ALLOWED_HOSTS.',
      },
      health: `${origin}/health`,
    },
    { headers },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return infoResponse(request, env);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const headers = corsHeaders(request, env);
      headers.set("Cache-Control", "no-store");
      return Response.json({ ok: true, name: SERVER_NAME, version: VERSION }, { headers });
    }

    if (url.pathname !== "/mcp") {
      return new Response("Not found", {
        status: 404,
        headers: corsHeaders(request, env),
      });
    }

    const auth = await authenticate(request, env);
    if ("response" in auth) return auth.response;

    const hosts = allowedHostnames(env);
    const originHostnames = corsOriginHostnames(env);

    const handler = createMcpHandler(() => createServer(auth.props), {
      route: "/mcp",
      ...(hosts ? { allowedHostnames: hosts } : {}),
      ...(originHostnames ? { allowedOriginHostnames: originHostnames } : {}),
      onerror: (error) => {
        console.error("hyperdx-mcp error:", redactSecret(error.message, auth.props.apiKey));
      },
    });

    return withNoStore(await handler(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
