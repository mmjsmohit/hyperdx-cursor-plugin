// Zero-dependency read-only HyperDX MCP server (stdio, newline-delimited JSON-RPC).
import readline from 'node:readline';
const KEY = process.env.HYPERDX_API_KEY;
const BASE = (process.env.HYPERDX_API_URL && !process.env.HYPERDX_API_URL.startsWith('${') ? process.env.HYPERDX_API_URL : 'https://api.hyperdx.io').replace(/\/$/, '');

async function api(path, body) {
  if (!KEY) throw new Error('HYPERDX_API_KEY not set');
  const r = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`HyperDX ${r.status} on ${path}: ${t.slice(0, 300)}`);
  return JSON.parse(t).data;
}
// Time window: ISO strings or "last" like 30m/2h/1d. Default last 1h.
function win(a) {
  const now = Date.now();
  const end = a.end ? Date.parse(a.end) : now;
  let start = a.start ? Date.parse(a.start) : null;
  if (start == null) {
    const m = /^(\d+)([mhd])$/.exec(a.last || '1h');
    if (!m) throw new Error('last must look like 30m, 2h, 1d');
    start = end - (+m[1]) * { m: 6e4, h: 36e5, d: 864e5 }[m[2]];
  }
  if (isNaN(start) || isNaN(end)) throw new Error('bad start/end');
  return { startTime: start, endTime: end };
}
const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
async function series(a, s, granularity) {
  return api('/api/v1/charts/series', { ...win(a), ...(granularity ? { granularity } : {}), series: [{ dataSource: 'events', ...s }] });
}
const W = {
  last: { type: 'string', description: 'Relative window ending now/at end: 15m, 2h, 1d. Default 1h.' },
  start: { type: 'string', description: 'ISO start (overrides last)' },
  end: { type: 'string', description: 'ISO end (default now)' },
};
const tools = {
  find_error_groups: {
    description: 'ErrorGroup[]: count of log/span events grouped by service+body+trace_id for a Lucene-style query (default level:error). HyperDX external API has no raw row search; this is the closest. Use to find failing messages and sample trace ids.',
    schema: { query: { type: 'string', description: 'HyperDX search syntax, e.g. level:error service:api' }, limit: { type: 'number', description: 'max groups (default 50)' }, ...W },
    run: async (a) => {
      const d = await series(a, { aggFn: 'count', where: a.query ?? 'level:error', groupBy: ['service', 'body', 'trace_id'] });
      return d.sort((x, y) => y['series_0.data'] - x['series_0.data']).slice(0, a.limit || 50)
        .map((r) => ({ service: r.group[0], body: r.group[1], traceId: r.group[2] || null, count: r['series_0.data'] }));
    },
  },
  get_trace: {
    description: 'TraceSpan[] for one trace id: each distinct span/log (service, span_name, level, body) with event count and max duration (ms). Use after find_error_groups.',
    required: ['trace_id'],
    schema: { trace_id: { type: 'string' }, last: { ...W.last, description: 'Window to search (default 1d)' }, start: W.start, end: W.end },
    run: async (a) => {
      const d = await series({ last: '1d', ...a }, { aggFn: 'max', field: 'duration', where: `trace_id:"${a.trace_id}"`, groupBy: ['service', 'span_name', 'level', 'body'] });
      return d.map((r) => ({ service: r.group[0], spanName: r.group[1] || null, level: r.group[2] || null, body: r.group[3], maxDurationMs: r['series_0.data'] }));
    },
  },
  event_series: {
    description: 'SeriesPoint[]: time-bucketed aggregate over events (count, or avg/p95/max/sum of a numeric field like duration), optionally grouped. Use to see when an incident started/ended.',
    schema: { query: { type: 'string', description: 'where clause, e.g. level:error' }, aggFn: { type: 'string', enum: ['count', 'avg', 'sum', 'min', 'max', 'p50', 'p90', 'p95', 'p99', 'count_distinct'] }, field: { type: 'string' }, groupBy: { type: 'array', items: { type: 'string' } }, granularity: { type: 'string', description: 'e.g. "1 minute", "5 minute", "1 hour"' }, ...W },
    run: async (a) => {
      const d = await series(a, { aggFn: a.aggFn || 'count', ...(a.field ? { field: a.field } : {}), where: a.query || '', groupBy: a.groupBy || [] }, a.granularity || '5 minute');
      return d.map((r) => ({ ts: iso(r.ts_bucket), group: r.group, value: r['series_0.data'] }));
    },
  },
  list_services: {
    description: 'Service[]: services seen in window with event and error counts.',
    schema: { ...W },
    run: async (a) => {
      const [all, err] = await Promise.all([
        series(a, { aggFn: 'count', where: '', groupBy: ['service'] }),
        series(a, { aggFn: 'count', where: 'level:error', groupBy: ['service'] }),
      ]);
      const e = Object.fromEntries(err.map((r) => [r.group[0], r['series_0.data']]));
      return all.map((r) => ({ service: r.group[0], events: r['series_0.data'], errors: e[r.group[0]] || 0 })).sort((x, y) => y.errors - x.errors);
    },
  },
  list_alerts: { description: 'Alert[]: configured alerts (id, name, source, threshold, interval, savedSearchId/dashboardId, channel).', schema: {}, run: () => api('/api/v1/alerts') },
  list_dashboards: {
    description: 'Dashboard[]: dashboards with chart names and their series definitions (reusable as event_series queries).',
    schema: { name: { type: 'string', description: 'case-insensitive filter' } },
    run: async (a) => (await api('/api/v1/dashboards')).filter((d) => !a.name || d.name?.toLowerCase().includes(a.name.toLowerCase()))
      .map((d) => ({ id: d.id, name: d.name, charts: (d.charts || []).map((c) => ({ name: c.name, series: c.series })) })),
  },
  list_metrics: {
    description: 'MetricName[]: metric names/types with distinct tag sets (truncated). Use before querying metrics in HyperDX.',
    schema: { name: { type: 'string', description: 'substring filter' } },
    run: async (a) => (await api('/api/v1/metrics/tags')).filter((m) => !a.name || m.name.includes(a.name))
      .map((m) => ({ name: m.name, type: m.type, tagSets: m.tags.length, sampleTags: m.tags.slice(0, 3) })),
  },
};

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    let result;
    if (method === 'initialize') result = { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'hyperdx', version: '0.1.0' } };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.schema, required: t.required || [] }, annotations: { readOnlyHint: true } })) };
    else if (method === 'tools/call') {
      const t = tools[params?.name];
      if (!t) throw Object.assign(new Error('unknown tool'), { code: -32602 });
      try { result = { content: [{ type: 'text', text: JSON.stringify(await t.run(params.arguments || {}), null, 1) }] }; }
      catch (e) { result = { isError: true, content: [{ type: 'text', text: String(e.message).replaceAll(KEY || '\0', '***') }] }; }
    } else throw Object.assign(new Error('method not found'), { code: -32601 });
    send({ jsonrpc: '2.0', id, result });
  } catch (e) { send({ jsonrpc: '2.0', id, error: { code: e.code || -32603, message: e.message } }); }
});
