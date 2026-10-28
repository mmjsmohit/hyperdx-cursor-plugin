// Shared, zero-dependency, read-only HyperDX API client.
//
// Used by both:
//   - server/index.mjs  (local stdio MCP server for Cursor)
//   - worker/src/index.ts (remote Streamable HTTP MCP server on Cloudflare)
//
// Keeping the query logic here means the local plugin and the hosted server
// return exactly the same shapes.

const DEFAULT_BASE_URL = 'https://api.hyperdx.io';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const WINDOW_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const AGG_FNS = ['count', 'avg', 'sum', 'min', 'max', 'p50', 'p90', 'p95', 'p99', 'count_distinct'];

export class HyperdxError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, path?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'HyperdxError';
    this.status = details.status;
    this.path = details.path;
  }
}

/**
 * Remove a secret from an error/log string. Never log request headers.
 * @param {unknown} value
 * @param {string | undefined} secret
 * @returns {string}
 */
export function redactSecret(value, secret) {
  const text = String(value ?? '');
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join('***');
}

/**
 * Validate and normalize a HyperDX API base URL.
 * @param {string | undefined} input
 * @returns {string}
 */
export function normalizeBaseUrl(input) {
  let url;
  try {
    url = new URL(input || DEFAULT_BASE_URL);
  } catch {
    throw new Error('HyperDX API URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('HyperDX API URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('HyperDX API URL must not contain credentials');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Turn `last` / `start` / `end` into HyperDX's millisecond window.
 * @param {{ last?: string, start?: string, end?: string }} [args]
 * @returns {{ startTime: number, endTime: number }}
 */
export function resolveWindow(args = {}) {
  const now = Date.now();
  const end = args.end ? Date.parse(args.end) : now;
  if (!Number.isFinite(end)) throw new Error('end must be an ISO date');

  let start;
  if (args.start) {
    start = Date.parse(args.start);
    if (!Number.isFinite(start)) throw new Error('start must be an ISO date');
  } else {
    const last = args.last || '1h';
    const match = /^(\d{1,4})([mhd])$/.exec(last);
    if (!match) throw new Error('last must look like 15m, 2h, or 1d');
    start = end - Number(match[1]) * WINDOW_UNITS[match[2]];
  }

  if (start >= end) throw new Error('start must be before end');
  if (end - start > MAX_WINDOW_MS) throw new Error('time window must be 90 days or less');
  return { startTime: start, endTime: end };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

/**
 * @param {number | string | undefined} value
 * @returns {string | null}
 */
function iso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {number}
 */
function seriesValue(row) {
  const value = row['series_0.data'];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} index
 * @returns {string | null}
 */
function groupOf(row, index) {
  return Array.isArray(row.group) ? row.group[index] ?? null : null;
}

/**
 * Tool descriptions shared by the stdio and Worker servers.
 */
export const TOOL_DESCRIPTIONS = Object.freeze({
  find_error_groups:
    'ErrorGroup[]: count of log/span events grouped by service+body+trace_id for a Lucene-style query (default level:error). HyperDX external API has no raw row search; this is the closest. Use to find failing messages and sample trace ids.',
  get_trace:
    'TraceSpan[] for one trace id: each distinct span/log (service, span_name, level, body) with event count and max duration (ms), slowest first. Use after find_error_groups.',
  event_series:
    'SeriesPoint[]: time-bucketed aggregate over events (count, or avg/p95/max/sum of a numeric field like duration), optionally grouped. Use to see when an incident started/ended.',
  list_services:
    'Service[]: services seen in window with event and error counts, most errors first.',
  list_alerts:
    'Alert[]: configured alerts (id, name, source, threshold, interval, savedSearchId/dashboardId, channel).',
  list_dashboards:
    'Dashboard[]: dashboards with chart names and their series definitions (reusable as event_series queries).',
  list_metrics:
    'MetricName[]: metric names/types with distinct tag sets (truncated). Use before querying metrics in HyperDX.',
});

/**
 * @typedef {Object} WindowArgs
 * @property {string} [last]  Relative window ending at `end`/now: 15m, 2h, 1d.
 * @property {string} [start] ISO start (overrides last).
 * @property {string} [end]   ISO end (default now).
 */

/**
 * @typedef {WindowArgs & { query?: string, limit?: number }} FindErrorGroupsArgs
 */

/**
 * @typedef {WindowArgs & { trace_id: string }} GetTraceArgs
 */

/**
 * @typedef {WindowArgs & {
 *   query?: string,
 *   aggFn?: string,
 *   field?: string,
 *   groupBy?: string[],
 *   granularity?: string,
 *   limit?: number
 * }} EventSeriesArgs
 */

/**
 * @typedef {Object} ListDashboardsArgs
 * @property {string} [name]
 * @property {number} [limit]
 */

/**
 * @typedef {Object} ListMetricsArgs
 * @property {string} [name]
 * @property {number} [limit]
 */

/**
 * @typedef {Object} HyperdxClient
 * @property {(args?: FindErrorGroupsArgs) => Promise<Array<Record<string, unknown>>>} findErrorGroups
 * @property {(args: GetTraceArgs) => Promise<Array<Record<string, unknown>>>} getTrace
 * @property {(args?: EventSeriesArgs) => Promise<Array<Record<string, unknown>>>} eventSeries
 * @property {(args?: WindowArgs) => Promise<Array<Record<string, unknown>>>} listServices
 * @property {() => Promise<unknown>} listAlerts
 * @property {(args?: ListDashboardsArgs) => Promise<Array<Record<string, unknown>>>} listDashboards
 * @property {(args?: ListMetricsArgs) => Promise<Array<Record<string, unknown>>>} listMetrics
 */

/**
 * Create a read-only HyperDX client bound to one API key.
 *
 * @param {{
 *   apiKey: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   userAgent?: string
 * }} options
 * @returns {HyperdxClient}
 */
export function createHyperdxClient(options) {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = 'hyperdx-mcp/0.2.0',
  } = options || {};

  if (!apiKey) throw new Error('HyperDX API key is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  const base = normalizeBaseUrl(baseUrl);

  /**
   * @param {string} path
   * @param {Record<string, unknown>} [body]
   * @returns {Promise<any>}
   */
  async function api(path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': userAgent,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const raw = error && typeof error === 'object' && 'message' in error ? error.message : String(error);
      const message =
        error && typeof error === 'object' && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? `HyperDX request timed out after ${timeoutMs}ms`
          : `HyperDX request failed: ${raw}`;
      throw new HyperdxError(redactSecret(message, apiKey));
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = redactSecret(text.slice(0, 500), apiKey);
      throw new HyperdxError(
        `HyperDX ${response.status} on ${path}${detail ? `: ${detail}` : ''}`,
        { status: response.status, path },
      );
    }

    if (!text) return null;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HyperdxError(`HyperDX returned invalid JSON on ${path}`);
    }
    if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
    return payload;
  }

  /**
   * @param {WindowArgs} args
   * @param {Record<string, unknown>} series
   * @param {string} [granularity]
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function querySeries(args, series, granularity) {
    const data = await api('/api/v1/charts/series', {
      ...resolveWindow(args),
      ...(granularity ? { granularity } : {}),
      series: [{ dataSource: 'events', ...series }],
    });
    if (!Array.isArray(data)) throw new HyperdxError('Unexpected HyperDX series response');
    return data;
  }

  return {
    async findErrorGroups(args = {}) {
      const limit = clampInt(args.limit, 50, 1, 500);
      const rows = await querySeries(args, {
        aggFn: 'count',
        where: args.query || 'level:error',
        groupBy: ['service', 'body', 'trace_id'],
      });
      return rows
        .map((row) => ({
          service: groupOf(row, 0),
          body: groupOf(row, 1),
          traceId: groupOf(row, 2),
          count: seriesValue(row),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    },

    async getTrace(args) {
      const traceId = typeof args?.trace_id === 'string' ? args.trace_id.trim() : '';
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(traceId)) {
        throw new Error('trace_id must be 1-200 characters of letters, digits, ".", "_", ":", or "-"');
      }
      const rows = await querySeries(
        { last: args.last || '1d', start: args.start, end: args.end },
        {
          aggFn: 'max',
          field: 'duration',
          where: `trace_id:"${traceId}"`,
          groupBy: ['service', 'span_name', 'level', 'body'],
        },
      );
      return rows
        .map((row) => ({
          service: groupOf(row, 0),
          spanName: groupOf(row, 1),
          level: groupOf(row, 2),
          body: groupOf(row, 3),
          maxDurationMs: seriesValue(row),
        }))
        .sort((a, b) => b.maxDurationMs - a.maxDurationMs);
    },

    async eventSeries(args = {}) {
      const aggFn = args.aggFn || 'count';
      if (!AGG_FNS.includes(aggFn)) {
        throw new Error(`aggFn must be one of: ${AGG_FNS.join(', ')}`);
      }

      const field = typeof args.field === 'string' ? args.field.trim() : '';
      if (aggFn !== 'count' && !field) throw new Error(`field is required for aggFn "${aggFn}"`);
      if (field && !/^[A-Za-z0-9_.@-]{1,128}$/.test(field)) {
        throw new Error('field contains unsupported characters');
      }

      const groupBy = Array.isArray(args.groupBy) ? args.groupBy : [];
      if (groupBy.length > 5) throw new Error('groupBy supports at most 5 fields');
      for (const group of groupBy) {
        if (typeof group !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(group)) {
          throw new Error('groupBy fields must be 1-64 characters of letters, digits, ".", "_", "@", or "-"');
        }
      }

      const granularity = args.granularity || '5 minute';
      if (granularity !== 'auto' && !/^\d{1,4}\s+(second|minute|hour|day)s?$/i.test(granularity)) {
        throw new Error('granularity must look like "1 minute", "5 minute", "1 hour", or "auto"');
      }

      const limit = clampInt(args.limit, 5000, 1, 10000);
      const rows = await querySeries(
        args,
        {
          aggFn,
          ...(aggFn !== 'count' && field ? { field } : {}),
          where: args.query || '',
          groupBy,
        },
        granularity,
      );

      return rows
        .map((row) => ({
          ts: iso(/** @type {number | string | undefined} */ (row.ts_bucket)),
          group: Array.isArray(row.group) ? row.group : [],
          value: seriesValue(row),
        }))
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
        .slice(0, limit);
    },

    async listServices(args = {}) {
      const [all, errors] = await Promise.all([
        querySeries(args, { aggFn: 'count', where: '', groupBy: ['service'] }),
        querySeries(args, { aggFn: 'count', where: 'level:error', groupBy: ['service'] }),
      ]);

      const errorCounts = new Map(
        errors.map((row) => [groupOf(row, 0) ?? '(unknown)', seriesValue(row)]),
      );

      return all
        .map((row) => {
          const service = groupOf(row, 0) ?? '(unknown)';
          return { service, events: seriesValue(row), errors: errorCounts.get(service) ?? 0 };
        })
        .sort((a, b) => b.errors - a.errors || b.events - a.events);
    },

    async listAlerts() {
      return api('/api/v1/alerts');
    },

    async listDashboards(args = {}) {
      const dashboards = await api('/api/v1/dashboards');
      if (!Array.isArray(dashboards)) return [];
      const needle = typeof args.name === 'string' ? args.name.toLowerCase() : '';
      const limit = clampInt(args.limit, 200, 1, 500);
      return dashboards
        .filter((dashboard) => !needle || String(dashboard.name || '').toLowerCase().includes(needle))
        .slice(0, limit)
        .map((dashboard) => ({
          id: dashboard.id,
          name: dashboard.name,
          charts: (dashboard.charts || []).map((chart) => ({
            name: chart.name,
            series: chart.series,
          })),
        }));
    },

    async listMetrics(args = {}) {
      const metrics = await api('/api/v1/metrics/tags');
      if (!Array.isArray(metrics)) return [];
      const needle = typeof args.name === 'string' ? args.name.toLowerCase() : '';
      const limit = clampInt(args.limit, 200, 1, 1000);
      return metrics
        .filter((metric) => !needle || String(metric.name || '').toLowerCase().includes(needle))
        .slice(0, limit)
        .map((metric) => {
          const tags = Array.isArray(metric.tags) ? metric.tags : [];
          return {
            name: metric.name,
            type: metric.type,
            tagSets: tags.length,
            sampleTags: tags.slice(0, 3),
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
  };
}
