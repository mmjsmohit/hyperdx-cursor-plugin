# HyperDX Cursor Plugin

Read-only [HyperDX](https://www.hyperdx.io/) context for root-cause analysis and coding: a zero-dependency Node MCP server plus an RCA skill, with an optional multi-user remote deployment on Cloudflare Workers.

## Tools
- `find_error_groups` – top error messages (service, body, sample trace id, count)
- `get_trace` – spans/logs for one trace id, slowest first
- `event_series` – time-bucketed count/avg/p95/... over events, optionally grouped
- `list_services` – services with event and error counts
- `list_alerts`, `list_dashboards`, `list_metrics`

Time windows: `last` (`15m`, `2h`, `1d`) or ISO `start`/`end`.

## Local install (Cursor IDE)
1. Copy this folder to `~/.cursor/plugins/local/hyperdx` (with `plugin.json` at its root).
2. Set `HYPERDX_API_KEY` (your HyperDX Personal API Access Key). Optional `HYPERDX_API_URL` (default `https://api.hyperdx.io`).
3. Requires Node 18+. Restart Cursor.

## Remote MCP server (Cloudflare)
The [`worker/`](worker/) directory deploys the same read-only tools as a stateless remote MCP server using Cloudflare's Agents SDK and Streamable HTTP. One deployment can serve a whole team: every caller supplies their own HyperDX API key, so each person sees only the data their HyperDX account can access and no shared key is stored on the server.

Quick start:

```sh
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

The endpoint will be `https://hyperdx-mcp.<your-subdomain>.workers.dev/mcp`.

See [`worker/README.md`](worker/README.md) for:

- client setup for Cursor, Claude Code, VS Code, and MCP Inspector
- per-user keys, an optional shared access gate, and a shared-key fallback
- custom domains, Cloudflare Access, and self-hosted HyperDX
- local development, smoke tests, and security notes

The local stdio server and the Worker share the same query logic in [`shared/hyperdx.mjs`](shared/hyperdx.mjs).

## Development
```sh
cd worker
npm test          # shared client unit tests
npm run typecheck
npm run deploy:dry
```

## Limitations
The HyperDX external API (v1) has no raw log row search, so errors are returned as aggregated groups via `POST /api/v1/charts/series`. Uses `/api/v1/alerts`, `/api/v1/dashboards`, `/api/v1/metrics/tags`.

## License
MIT
