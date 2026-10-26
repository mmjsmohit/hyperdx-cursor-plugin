# HyperDX Cursor Plugin

Read-only [HyperDX](https://www.hyperdx.io/) context for root-cause analysis and coding in Cursor: a zero-dependency Node MCP server plus an RCA skill.

## Tools
- `find_error_groups` – top error messages (service, body, sample trace id, count)
- `get_trace` – spans/logs for one trace id with max duration
- `event_series` – time-bucketed count/avg/p95/... over events, optionally grouped
- `list_services` – services with event and error counts
- `list_alerts`, `list_dashboards`, `list_metrics`

Time windows: `last` (`15m`, `2h`, `1d`) or ISO `start`/`end`.

## Install (Cursor IDE)
1. Copy this folder to `~/.cursor/plugins/local/hyperdx` (with `plugin.json` at its root).
2. Set `HYPERDX_API_KEY` (your HyperDX Personal API Access Key). Optional `HYPERDX_API_URL` (default `https://api.hyperdx.io`).
3. Requires Node 18+. Restart Cursor.

## Limitations
The HyperDX external API (v1) has no raw log row search, so errors are returned as aggregated groups via `POST /api/v1/charts/series`. Uses `/api/v1/alerts`, `/api/v1/dashboards`, `/api/v1/metrics/tags`.

## License
MIT
