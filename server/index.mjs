#!/usr/bin/env node
// Zero-dependency read-only HyperDX MCP server (stdio, newline-delimited JSON-RPC).
//
// The remote Cloudflare Worker uses the same shared client. Keep tool names,
// descriptions, and result shapes in sync via ../shared/hyperdx.mjs.
import readline from 'node:readline';
import {
  TOOL_DESCRIPTIONS,
  createHyperdxClient,
  redactSecret,
} from '../shared/hyperdx.mjs';

const VERSION = '0.2.0';
const KEY = process.env.HYPERDX_API_KEY;
const BASE =
  process.env.HYPERDX_API_URL && !process.env.HYPERDX_API_URL.startsWith('${')
    ? process.env.HYPERDX_API_URL
    : undefined;

let client;
function getClient() {
  if (!KEY) throw new Error('HYPERDX_API_KEY not set');
  if (!client) {
    client = createHyperdxClient({
      apiKey: KEY,
      baseUrl: BASE,
      userAgent: `hyperdx-mcp-stdio/${VERSION}`,
    });
  }
  return client;
}

const W = {
  last: { type: 'string', description: 'Relative window ending now/at end: 15m, 2h, 1d. Default 1h.' },
  start: { type: 'string', description: 'ISO start (overrides last)' },
  end: { type: 'string', description: 'ISO end (default now)' },
};

const tools = {
  find_error_groups: {
    description: TOOL_DESCRIPTIONS.find_error_groups,
    schema: {
      query: { type: 'string', description: 'HyperDX search syntax, e.g. level:error service:api. Default level:error.' },
      limit: { type: 'number', description: 'Max groups to return (1-500, default 50).' },
      ...W,
    },
    run: (a) => getClient().findErrorGroups(a),
  },
  get_trace: {
    description: TOOL_DESCRIPTIONS.get_trace,
    required: ['trace_id'],
    schema: {
      trace_id: { type: 'string', description: 'Trace id from find_error_groups or a log line.' },
      last: { ...W.last, description: 'Window to search (default 1d).' },
      start: W.start,
      end: W.end,
    },
    run: (a) => getClient().getTrace(a),
  },
  event_series: {
    description: TOOL_DESCRIPTIONS.event_series,
    schema: {
      query: { type: 'string', description: 'Where clause, e.g. level:error service:api.' },
      aggFn: {
        type: 'string',
        enum: ['count', 'avg', 'sum', 'min', 'max', 'p50', 'p90', 'p95', 'p99', 'count_distinct'],
        description: 'Aggregation (default count).',
      },
      field: { type: 'string', description: 'Numeric field for avg/sum/min/max/p50.../count_distinct.' },
      groupBy: { type: 'array', items: { type: 'string' }, description: 'Up to 5 fields, e.g. ["service"].' },
      granularity: { type: 'string', description: 'Bucket size: "1 minute", "5 minute", "1 hour", or "auto". Default "5 minute".' },
      limit: { type: 'number', description: 'Max points to return (1-10000, default 5000).' },
      ...W,
    },
    run: (a) => getClient().eventSeries(a),
  },
  list_services: {
    description: TOOL_DESCRIPTIONS.list_services,
    schema: { ...W },
    run: (a) => getClient().listServices(a),
  },
  list_alerts: {
    description: TOOL_DESCRIPTIONS.list_alerts,
    schema: {},
    run: () => getClient().listAlerts(),
  },
  list_dashboards: {
    description: TOOL_DESCRIPTIONS.list_dashboards,
    schema: {
      name: { type: 'string', description: 'Case-insensitive dashboard name filter.' },
      limit: { type: 'number', description: 'Max dashboards to return (1-500, default 200).' },
    },
    run: (a) => getClient().listDashboards(a),
  },
  list_metrics: {
    description: TOOL_DESCRIPTIONS.list_metrics,
    schema: {
      name: { type: 'string', description: 'Case-insensitive metric name filter.' },
      limit: { type: 'number', description: 'Max metrics to return (1-1000, default 200).' },
    },
    run: (a) => getClient().listMetrics(a),
  },
};

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  try {
    let result;
    if (method === 'initialize') {
      result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hyperdx', version: VERSION },
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = {
        tools: Object.entries(tools).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: {
            type: 'object',
            properties: tool.schema,
            required: tool.required || [],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, openWorldHint: true },
        })),
      };
    } else if (method === 'tools/call') {
      const tool = tools[params?.name];
      if (!tool) throw Object.assign(new Error('unknown tool'), { code: -32602 });
      try {
        result = {
          content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments || {}), null, 1) }],
        };
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: 'text', text: redactSecret(error?.message || error, KEY) }],
        };
      }
    } else {
      throw Object.assign(new Error('method not found'), { code: -32601 });
    }
    send({ jsonrpc: '2.0', id, result });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: error.code || -32603, message: redactSecret(error.message, KEY) },
    });
  }
});
