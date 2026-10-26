---
name: hyperdx-rca
description: Use when investigating an incident, error, alert, slow request, or bug in production/dev services that send telemetry to HyperDX, or when coding a fix that needs real error/trace context.
---
# HyperDX RCA

All tools are read-only. Only report what the tools return; never invent log lines, trace ids, or counts. Times are UTC ISO.

1. **Scope**: `list_services` (last 1h–1d) to see who is erroring. If an alert fired, `list_alerts` to get its threshold/saved search.
2. **When**: `event_series` with `query: "level:error service:<svc>"`, `granularity: "1 minute"` to find onset and end. Narrow `start`/`end` to that window.
3. **What**: `find_error_groups` with the narrowed window and query → top messages + sample `traceId`s.
4. **Where**: `get_trace` on 1–3 trace ids → which service/span failed, slowest span (`maxDurationMs`).
5. **Correlate**: `event_series` with `aggFn: p95, field: duration, groupBy: ["service"]` for latency; `list_dashboards`/`list_metrics` for infra signals.
6. **Then code**: grep the repo for the error body text / span name; cite the HyperDX evidence (service, window, count, trace id) in the RCA.

Limits: the HyperDX external API has no raw log row search; error groups are aggregated rows (service, body, trace_id) with counts. If a query returns `[]`, widen `last` or loosen the query before concluding.
