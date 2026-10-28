// Minimal mock of the HyperDX external API for local Worker smoke tests.
// Run: node test/mock-hyperdx.mjs
import http from 'node:http';

const PORT = Number(process.env.PORT || 8799);
const EXPECTED_KEY = process.env.EXPECTED_KEY || 'test-key-1234567890';

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const errorGroups = [
  { group: ['api', 'upstream timeout calling billing', 'trace-abc'], 'series_0.data': 42 },
  { group: ['worker', 'TypeError: cannot read properties of undefined', 'trace-def'], 'series_0.data': 17 },
];

const spans = [
  { group: ['api', 'POST /checkout', 'error', 'upstream timeout calling billing'], 'series_0.data': 3200 },
  { group: ['db', 'SELECT orders', 'info', 'slow query'], 'series_0.data': 1800 },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const authorization = req.headers.authorization || '';

  if (authorization !== `Bearer ${EXPECTED_KEY}`) {
    send(res, 401, { error: 'invalid API key' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/alerts') {
    send(res, 200, {
      data: [
        {
          id: 'alert-1',
          name: 'High error rate',
          source: 'saved_search',
          threshold: 5,
          interval: '1m',
        },
      ],
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/dashboards') {
    send(res, 200, {
      data: [
        {
          id: 'dash-1',
          name: 'API Overview',
          charts: [{ name: 'Errors', series: [{ aggFn: 'count', where: 'level:error' }] }],
        },
      ],
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/v1/metrics/tags') {
    send(res, 200, {
      data: [
        {
          name: 'http.server.duration',
          type: 'histogram',
          tags: [{ service: 'api' }, { service: 'worker' }],
        },
      ],
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/v1/charts/series') {
    const body = await readBody(req);
    const series = body?.series?.[0] || {};
    const where = String(series.where || '');
    const groupBy = Array.isArray(series.groupBy) ? series.groupBy : [];

    if (body?.granularity) {
      send(res, 200, {
        data: [
          { ts_bucket: Date.parse('2026-10-28T12:00:00Z'), group: ['api'], 'series_0.data': 3 },
          { ts_bucket: Date.parse('2026-10-28T12:05:00Z'), group: ['api'], 'series_0.data': 8 },
        ],
      });
      return;
    }

    if (where.startsWith('trace_id:')) {
      send(res, 200, { data: spans });
      return;
    }

    if (where === 'level:error' && groupBy.includes('body')) {
      send(res, 200, { data: errorGroups });
      return;
    }

    if (where === 'level:error') {
      send(res, 200, {
        data: [
          { group: ['api'], 'series_0.data': 59 },
          { group: ['worker'], 'series_0.data': 17 },
        ],
      });
      return;
    }

    send(res, 200, {
      data: [
        { group: ['api'], 'series_0.data': 1200 },
        { group: ['worker'], 'series_0.data': 300 },
        { group: ['db'], 'series_0.data': 800 },
      ],
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock HyperDX listening on http://127.0.0.1:${PORT}`);
});
