// End-to-end smoke test for the remote Worker.
//
// Start the mock API and `wrangler dev` first:
//   node test/mock-hyperdx.mjs
//   npx wrangler dev --port 8788 --var HYPERDX_API_URL:http://127.0.0.1:8799
//   node test/smoke.mjs http://127.0.0.1:8788/mcp test-key-1234567890
//
// Optional third argument is the X-MCP-Access-Token gate.
const url = process.argv[2] || 'http://127.0.0.1:8788/mcp';
const apiKey = process.argv[3] || 'test-key-1234567890';
const gateToken = process.argv[4] || '';
const origin = new URL(url).origin;

let protocolVersion = '';
let nextId = 1;

function requestHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    ...(gateToken ? { 'X-MCP-Access-Token': gateToken } : {}),
    ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
    ...extra,
  };
}

function parseRpcResponse(text, contentType) {
  if ((contentType || '').includes('text/event-stream')) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return messages.find((message) => message.id !== undefined) ?? messages.at(-1);
  }
  return text ? JSON.parse(text) : null;
}

async function rpc(method, params, headers = requestHeaders()) {
  const id = nextId++;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const message = parseRpcResponse(text, response.headers.get('content-type'));
  if (!message) throw new Error(`${method} returned no JSON-RPC message`);
  if (message.error) throw new Error(`${method} JSON-RPC error: ${JSON.stringify(message.error)}`);
  return message.result;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert(
    Array.isArray(result.content) && result.content[0]?.type === 'text',
    `${name} returned text content`,
  );
  if (result.isError) throw new Error(`${name} returned an error: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}

const health = await fetch(`${origin}/health`);
assert(health.ok, 'GET /health returns 200');
console.log('health ok:', await health.json());

const info = await fetch(`${origin}/`);
assert(info.ok, 'GET / returns 200');
const infoBody = await info.json();
assert(infoBody.endpoint === url, 'GET / advertises the /mcp endpoint');
console.log('info ok:', infoBody.name, infoBody.version);

const init = await rpc('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'hyperdx-smoke', version: '1.0.0' },
});
protocolVersion = init.protocolVersion;
console.log(
  `initialize ok: ${init.serverInfo.name} ${init.serverInfo.version} (protocol ${protocolVersion})`,
);

const list = await rpc('tools/list', {});
const names = list.tools.map((tool) => tool.name).sort();
assert(names.length === 7, `expected 7 tools, got ${names.length}`);
console.log(`tools/list ok: ${names.join(', ')}`);

const groups = await callTool('find_error_groups', {
  query: 'level:error',
  last: '1h',
  limit: 10,
});
assert(groups.length === 2, 'find_error_groups returns two groups');
assert(groups[0].count === 42, 'find_error_groups sorts by count');
console.log('find_error_groups ok:', groups[0]);

const spans = await callTool('get_trace', { trace_id: 'trace-abc' });
assert(spans[0].maxDurationMs === 3200, 'get_trace sorts slowest first');
console.log('get_trace ok:', spans[0]);

const points = await callTool('event_series', {
  query: 'level:error',
  aggFn: 'p95',
  field: 'duration',
  granularity: '1 minute',
  last: '1h',
});
assert(points.length === 2, 'event_series returns points');
assert(points[0].ts < points[1].ts, 'event_series is chronological');
console.log('event_series ok:', points[0]);

const services = await callTool('list_services', { last: '1h' });
assert(services[0].service === 'api' && services[0].errors === 59, 'list_services sorts by errors');
console.log('list_services ok:', services[0]);

const alerts = await callTool('list_alerts', {});
assert(alerts.length === 1, 'list_alerts returns alerts');
console.log('list_alerts ok:', alerts[0].name);

const dashboards = await callTool('list_dashboards', { name: 'api' });
assert(dashboards.length === 1, 'list_dashboards filters');
console.log('list_dashboards ok:', dashboards[0].name);

const metrics = await callTool('list_metrics', { name: 'duration' });
assert(metrics.length === 1, 'list_metrics filters');
console.log('list_metrics ok:', metrics[0].name);

const missingKey = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 99,
    method: 'initialize',
    params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
  }),
});
assert(missingKey.status === 401, `missing key should be 401, got ${missingKey.status}`);
console.log('auth ok: missing key rejected with 401');

const customUrl = await fetch(url, {
  method: 'POST',
  headers: requestHeaders({ 'X-HyperDX-Api-Url': 'https://evil.example.com' }),
  body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} }),
});
assert(customUrl.status === 403, `non-allowlisted base URL should be 403, got ${customUrl.status}`);
console.log('auth ok: non-allowlisted HyperDX URL rejected with 403');

if (gateToken) {
  const badGate = await fetch(url, {
    method: 'POST',
    headers: requestHeaders({ 'X-MCP-Access-Token': 'wrong-gate' }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} }),
  });
  assert(badGate.status === 401, `bad gate should be 401, got ${badGate.status}`);
  console.log('auth ok: bad access gate rejected with 401');
}

console.log('\nAll smoke checks passed.');
