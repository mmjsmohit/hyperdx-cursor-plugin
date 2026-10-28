import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HyperdxError,
  createHyperdxClient,
  normalizeBaseUrl,
  redactSecret,
  resolveWindow,
} from '../../shared/hyperdx.mjs';

const API_KEY = 'test-key-1234567890';
const BASE = 'https://hyperdx.example.com';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = await handler(call);
    if (result instanceof Response) return result;
    return jsonResponse({ data: result });
  };
  return { fetchImpl, calls };
}

function clientWith(handler, overrides = {}) {
  const { fetchImpl, calls } = mockFetch(handler);
  const client = createHyperdxClient({
    apiKey: API_KEY,
    baseUrl: BASE,
    fetchImpl,
    ...overrides,
  });
  return { client, calls };
}

test('resolveWindow supports relative and absolute windows', () => {
  const end = '2026-10-28T12:00:00.000Z';
  const relative = resolveWindow({ last: '2h', end });
  assert.equal(relative.endTime - relative.startTime, 2 * 3_600_000);

  const absolute = resolveWindow({ start: '2026-10-28T10:00:00.000Z', end });
  assert.equal(absolute.startTime, Date.parse('2026-10-28T10:00:00.000Z'));

  assert.throws(() => resolveWindow({ last: '2w' }), /last must look like/);
  assert.throws(() => resolveWindow({ start: end, end }), /start must be before end/);
  assert.throws(() => resolveWindow({ last: '91d', end }), /90 days/);
  assert.throws(() => resolveWindow({ start: 'nope' }), /ISO date/);
});

test('normalizeBaseUrl validates and trims trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://api.hyperdx.io/'), 'https://api.hyperdx.io');
  assert.equal(
    normalizeBaseUrl('https://hyperdx.example.com/prefix/'),
    'https://hyperdx.example.com/prefix',
  );
  assert.throws(() => normalizeBaseUrl('ftp://example.com'), /http or https/);
  assert.throws(() => normalizeBaseUrl('https://user:pass@example.com'), /credentials/);
  assert.throws(() => normalizeBaseUrl('not a url'), /valid URL/);
});

test('redactSecret removes keys from strings', () => {
  assert.equal(redactSecret(`oops ${API_KEY}`, API_KEY), 'oops ***');
  assert.equal(redactSecret('plain text', undefined), 'plain text');
  assert.equal(redactSecret('short', 'abc'), 'short');
});

test('client sends bearer auth and unwraps the data envelope', async () => {
  const { client, calls } = clientWith(() => [{ id: 'alert-1' }]);
  const alerts = await client.listAlerts();

  assert.deepEqual(alerts, [{ id: 'alert-1' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/api/v1/alerts`);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
});

test('client keeps a base path prefix', async () => {
  const { client, calls } = clientWith(() => [], { baseUrl: 'https://hyperdx.example.com/prefix/' });
  await client.listAlerts();
  assert.equal(calls[0].url, 'https://hyperdx.example.com/prefix/api/v1/alerts');
});

test('findErrorGroups sorts, limits, and defaults to level:error', async () => {
  const { client, calls } = clientWith(() => [
    { group: ['api', 'slow', 't1'], 'series_0.data': 3 },
    { group: ['api', 'boom', 't2'], 'series_0.data': 9 },
  ]);

  const groups = await client.findErrorGroups({ limit: 1 });

  assert.deepEqual(groups, [{ service: 'api', body: 'boom', traceId: 't2', count: 9 }]);
  assert.equal(calls[0].body.series[0].where, 'level:error');
  assert.deepEqual(calls[0].body.series[0].groupBy, ['service', 'body', 'trace_id']);
  assert.equal(calls[0].body.series[0].dataSource, 'events');
});

test('getTrace validates trace ids and sorts slowest spans first', async () => {
  const { client, calls } = clientWith(() => [
    { group: ['api', 'GET /a', 'info', 'ok'], 'series_0.data': 12 },
    { group: ['db', 'SELECT', 'error', 'boom'], 'series_0.data': 99 },
  ]);

  const spans = await client.getTrace({ trace_id: 'abc123' });

  assert.equal(spans[0].maxDurationMs, 99);
  assert.equal(spans[1].maxDurationMs, 12);
  assert.equal(calls[0].body.series[0].where, 'trace_id:"abc123"');
  assert.equal(calls[0].body.endTime - calls[0].body.startTime, 86_400_000);

  await assert.rejects(() => client.getTrace({ trace_id: 'abc" OR 1' }), /trace_id/);
  assert.equal(calls.length, 1);
});

test('eventSeries validates inputs and maps points chronologically', async () => {
  const { client, calls } = clientWith(() => [
    { ts_bucket: Date.parse('2026-10-28T12:05:00Z'), group: ['api'], 'series_0.data': 2 },
    { ts_bucket: Date.parse('2026-10-28T12:00:00Z'), group: ['api'], 'series_0.data': 1 },
  ]);

  const points = await client.eventSeries({
    query: 'level:error',
    aggFn: 'p95',
    field: 'duration',
    groupBy: ['service'],
    granularity: '1 minute',
  });

  assert.equal(points[0].ts, '2026-10-28T12:00:00.000Z');
  assert.equal(points[1].value, 2);
  assert.equal(calls[0].body.granularity, '1 minute');
  assert.equal(calls[0].body.series[0].aggFn, 'p95');
  assert.equal(calls[0].body.series[0].field, 'duration');

  await assert.rejects(() => client.eventSeries({ aggFn: 'p95' }), /field is required/);
  await assert.rejects(() => client.eventSeries({ aggFn: 'nope' }), /aggFn must be one of/);
  await assert.rejects(
    () => client.eventSeries({ groupBy: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    /at most 5/,
  );
  await assert.rejects(() => client.eventSeries({ granularity: '1h' }), /granularity/);
  await assert.rejects(() => client.eventSeries({ field: 'duration; DROP' }), /unsupported/);
});

test('eventSeries omits field for count aggregations', async () => {
  const { client, calls } = clientWith(() => []);
  await client.eventSeries({ aggFn: 'count', field: 'duration' });
  assert.equal('field' in calls[0].body.series[0], false);
});

test('listServices merges error counts and sorts by errors', async () => {
  const { client, calls } = clientWith(({ body }) => {
    const where = body.series[0].where;
    return where === 'level:error'
      ? [
          { group: ['api'], 'series_0.data': 4 },
          { group: ['db'], 'series_0.data': 1 },
        ]
      : [
          { group: ['api'], 'series_0.data': 100 },
          { group: ['db'], 'series_0.data': 50 },
          { group: ['web'], 'series_0.data': 10 },
        ];
  });

  const services = await client.listServices({ last: '1h' });

  assert.deepEqual(services, [
    { service: 'api', events: 100, errors: 4 },
    { service: 'db', events: 50, errors: 1 },
    { service: 'web', events: 10, errors: 0 },
  ]);
  assert.equal(calls.length, 2);
});

test('listDashboards filters by name and keeps chart series', async () => {
  const { client } = clientWith(() => [
    {
      id: 'd1',
      name: 'API Overview',
      charts: [{ name: 'Errors', series: [{ aggFn: 'count' }] }],
    },
    { id: 'd2', name: 'Database', charts: [] },
  ]);

  const dashboards = await client.listDashboards({ name: 'api' });

  assert.deepEqual(dashboards, [
    {
      id: 'd1',
      name: 'API Overview',
      charts: [{ name: 'Errors', series: [{ aggFn: 'count' }] }],
    },
  ]);
});

test('listMetrics filters, sorts, and truncates tags', async () => {
  const { client } = clientWith(() => [
    {
      name: 'http.server.duration',
      type: 'histogram',
      tags: [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }],
    },
    { name: 'db.client.duration', type: 'histogram', tags: [] },
  ]);

  const metrics = await client.listMetrics({ name: 'DURATION' });

  assert.deepEqual(
    metrics.map((metric) => metric.name),
    ['db.client.duration', 'http.server.duration'],
  );
  assert.equal(metrics[1].tagSets, 4);
  assert.equal(metrics[1].sampleTags.length, 3);
});

test('upstream errors include status but never the API key', async () => {
  const { fetchImpl } = mockFetch(
    () => new Response(`unauthorized ${API_KEY}`, { status: 401 }),
  );
  const client = createHyperdxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl });

  await assert.rejects(client.listAlerts(), (error) => {
    assert.ok(error instanceof HyperdxError);
    assert.equal(error.status, 401);
    assert.ok(error.message.includes('HyperDX 401'));
    assert.ok(!error.message.includes(API_KEY));
    assert.ok(error.message.includes('***'));
    return true;
  });
});

test('network errors are redacted', async () => {
  const { fetchImpl } = mockFetch(() => {
    throw new Error(`connect failed for ${API_KEY}`);
  });
  const client = createHyperdxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl });

  await assert.rejects(client.listAlerts(), (error) => {
    assert.ok(error.message.includes('HyperDX request failed'));
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
});

test('invalid upstream JSON is reported', async () => {
  const fetchImpl = async () => new Response('not json', { status: 200 });
  const client = createHyperdxClient({ apiKey: API_KEY, baseUrl: BASE, fetchImpl });
  await assert.rejects(client.listAlerts(), /invalid JSON/);
});

test('request timeouts are reported', async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
  const client = createHyperdxClient({
    apiKey: API_KEY,
    baseUrl: BASE,
    fetchImpl,
    timeoutMs: 10,
  });

  await assert.rejects(client.listAlerts(), /timed out/);
});
