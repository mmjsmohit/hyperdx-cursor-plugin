# Remote HyperDX MCP server on Cloudflare Workers

This directory deploys the HyperDX tools as a **stateless remote MCP server** using Cloudflare's Agents SDK (`createMcpHandler`) and Streamable HTTP. One deployment can serve a whole team.

The important design choice: **each caller supplies their own HyperDX Personal API key**. The Worker does not store a HyperDX key by default. That means:

- each person sees only the data their HyperDX account can access
- revoking one person is just revoking their HyperDX key
- no shared credential is sitting in the Worker
- keys are never logged, and error messages redact them

The Worker is stateless: no Durable Object, KV, D1, or session store. Every request creates a fresh `McpServer`.

## Deploy

Requirements: Node 20+ (22.18+ or 24.11+ recommended), a Cloudflare account, and a HyperDX Personal API Access Key.

```sh
cd worker
npm install
npx wrangler login          # or set CLOUDFLARE_API_TOKEN
npx wrangler deploy
```

Wrangler prints the deployed URL. It will look like:

```text
https://hyperdx-mcp.<your-subdomain>.workers.dev/mcp
```

If you already have a Worker named `hyperdx-mcp`, change `name` in `wrangler.jsonc` before deploying.

Check it:

```sh
curl https://hyperdx-mcp.<your-subdomain>.workers.dev/health
```

Then connect an MCP client (below) or run the inspector:

```sh
npx @modelcontextprotocol/inspector@latest
```

Use the deployed `/mcp` URL and add an `Authorization` header.

## Connect a client

### Cursor

Add this to `.cursor/mcp.json` (project) or the equivalent global MCP config:

```json
{
  "mcpServers": {
    "hyperdx": {
      "url": "https://hyperdx-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your-hyperdx-api-key>"
      }
    }
  }
}
```

Restart Cursor. If your Cursor version supports environment interpolation, prefer `${env:HYPERDX_API_KEY}` over a literal key.

### Claude Code

```sh
claude mcp add --transport http hyperdx \
  https://hyperdx-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer $HYPERDX_API_KEY"

claude mcp list
```

### VS Code

Add `.vscode/mcp.json`:

```json
{
  "servers": {
    "hyperdx": {
      "type": "http",
      "url": "https://hyperdx-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${input:hyperdx-key}"
      }
    }
  },
  "inputs": [
    {
      "id": "hyperdx-key",
      "type": "promptString",
      "description": "HyperDX API key",
      "password": true
    }
  ]
}
```

### MCP Inspector

Run `npx @modelcontextprotocol/inspector@latest`, enter the `/mcp` URL, and add:

```text
Authorization: Bearer <your-hyperdx-api-key>
```

### Other clients

Use the Streamable HTTP transport at `/mcp` and send either header:

```text
Authorization: Bearer <your-hyperdx-api-key>
X-HyperDX-Api-Key: <your-hyperdx-api-key>
```

`X-HyperDX-Api-Key` is useful when `Authorization` is reserved by a proxy or gateway.

## Authentication modes

### 1. Per-user keys (default, recommended)

Nothing to configure on the Worker. Each client sends its own HyperDX key. The key is used only for that request and is never persisted.

### 2. Per-user keys plus an org-wide gate

Set a gate token so the endpoint cannot be used even by someone who has a valid HyperDX key but was not given the gate token:

```sh
cd worker
npx wrangler secret put MCP_ACCESS_TOKEN
```

Every client then sends:

```text
X-MCP-Access-Token: <gate-token>
Authorization: Bearer <their-own-hyperdx-key>
```

The gate is checked before any HyperDX request is made.

### 3. Shared HyperDX key plus a gate

For clients that cannot send a HyperDX key, or for a team that intentionally wants one read-only key:

```sh
cd worker
npx wrangler secret put HYPERDX_API_KEY
npx wrangler secret put MCP_ACCESS_TOKEN
```

If a request has no per-user key, the Worker uses the shared key. The shared key **requires** `MCP_ACCESS_TOKEN`; if `HYPERDX_API_KEY` is set without a gate, the Worker returns `500` and refuses to use it. This is deliberate: a shared key without a gate would make the endpoint public.

Anyone with the gate token can query with the shared key, so use a read-only HyperDX key.

### Cloudflare Access

For SSO or network-level protection, put Cloudflare Access in front of the Worker. Access requires a **custom domain** in a Cloudflare zone (not a `*.workers.dev` hostname). Create an Access application for the custom domain, then have clients send Access service-token headers:

```text
CF-Access-Client-Id: <id>
CF-Access-Client-Secret: <secret>
```

Access is orthogonal to the HyperDX key: keep sending the user's HyperDX key as well. Interactive SSO login is not handled by most MCP clients, so Access service tokens are the practical option for CLI/IDE clients.

### Why not OAuth?

The Cloudflare guide also documents an OAuth authorization-server setup. It is not enabled here because every user already brings a HyperDX key that enforces their HyperDX permissions. Adding OAuth would introduce a second identity system and a second token store for little benefit. If you need OAuth, use Cloudflare Access in front, or add `OAuthResourceServer` from `@cloudflare/workers-oauth-provider` around the handler.

## Configuration

Set these in `wrangler.jsonc` under `vars` (non-secret) or with `wrangler secret put` (secret).

| Name | Kind | Required | Purpose |
| --- | --- | --- | --- |
| `HYPERDX_API_URL` | var | no | HyperDX API base URL. Default `https://api.hyperdx.io`. |
| `HYPERDX_API_KEY` | secret | no | Shared fallback key. Requires `MCP_ACCESS_TOKEN`. |
| `MCP_ACCESS_TOKEN` | secret | no | Org-wide gate checked via `X-MCP-Access-Token`. |
| `HYPERDX_ALLOWED_HOSTS` | var | no | Comma-separated hostnames allowed in `X-HyperDX-Api-Url`. |
| `MCP_ALLOWED_HOSTNAMES` | var | no | Comma-separated custom Worker hostnames (needed on a custom domain). |
| `CORS_ORIGINS` | var | no | Comma-separated browser origins/hostnames. Leave unset for wildcard responses with the handler's default Origin checks. |

Example `wrangler.jsonc` for a custom domain and self-hosted HyperDX:

```jsonc
{
  "name": "hyperdx-mcp",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-28",
  "compatibility_flags": ["nodejs_compat"],
  "routes": [
    { "pattern": "mcp.example.com", "custom_domain": true }
  ],
  "vars": {
    "HYPERDX_API_URL": "https://hyperdx.internal.example.com",
    "MCP_ALLOWED_HOSTNAMES": "mcp.example.com",
    "CORS_ORIGINS": "https://app.example.com"
  }
}
```

### Custom domain

1. Add the custom domain in **Workers & Pages → your Worker → Settings → Domains & Routes**, or with the `routes` entry above.
2. Set `MCP_ALLOWED_HOSTNAMES` to that hostname to enable explicit Host validation. Cloudflare routing already limits traffic, but setting this is recommended and also gives the MCP handler the correct hostname for custom-domain CORS defaults.
3. Set `CORS_ORIGINS` if a browser-based client will call the Worker from a specific origin.

### Self-hosted HyperDX

Set `HYPERDX_API_URL` in `wrangler.jsonc` and redeploy. That becomes the default for every caller.

If different users are on different HyperDX instances, allow per-request overrides:

```jsonc
"vars": {
  "HYPERDX_ALLOWED_HOSTS": "hyperdx.internal.example.com,hyperdx.other.example.com"
}
```

A client can then send:

```text
X-HyperDX-Api-Url: https://hyperdx.internal.example.com
```

Only `https` URLs whose hostname is in `HYPERDX_ALLOWED_HOSTS` are accepted. This prevents the Worker from being used as an SSRF proxy. `http` is accepted only for `localhost`/`127.0.0.1` in `HYPERDX_API_URL` for local development.

## Local development

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

The dev server listens on `http://localhost:8788`. The MCP endpoint is `http://localhost:8788/mcp`.

For a fully offline end-to-end check, use the mock HyperDX API:

```sh
# terminal 1
node test/mock-hyperdx.mjs

# terminal 2
npx wrangler dev --port 8788 --var HYPERDX_API_URL:http://127.0.0.1:8799

# terminal 3
node test/smoke.mjs http://127.0.0.1:8788/mcp test-key-1234567890
```

With the gate enabled:

```sh
npx wrangler dev --port 8788 \
  --var HYPERDX_API_URL:http://127.0.0.1:8799 \
  --var MCP_ACCESS_TOKEN:test-gate

node test/smoke.mjs http://127.0.0.1:8788/mcp test-key-1234567890 test-gate
```

## Tests and checks

```sh
cd worker
npm test          # unit tests for the shared client
npm run typecheck
npm run deploy:dry
```

The smoke test covers initialize, `tools/list`, all seven tools, missing-key `401`, non-allowlisted `X-HyperDX-Api-Url` `403`, and the gate `401` when configured.

## How it is put together

| File | Role |
| --- | --- |
| `src/index.ts` | Worker routes (`/`, `/health`, `/mcp`), MCP server factory, tool registration |
| `src/auth.ts` | Per-request key extraction, gate check, base-URL allowlist, CORS |
| `../shared/hyperdx.mjs` | Shared read-only HyperDX API client, also used by the local stdio server |
| `test/hyperdx.test.mjs` | Unit tests for the shared client |
| `test/mock-hyperdx.mjs` | Mock HyperDX API for local smoke tests |
| `test/smoke.mjs` | End-to-end Streamable HTTP smoke client |

The Worker uses:

- `createMcpHandler` from `agents/mcp/server` — stateless MCP request handling
- `McpServer` from `@modelcontextprotocol/server` — tool registration
- `zod` — input schemas

## Security notes

- **Read-only.** Every tool only calls HyperDX GET endpoints or the read-only series query endpoint. Tool annotations mark them read-only.
- **No key storage.** Per-user keys live only in request memory. Shared-key mode stores the key as a Worker secret.
- **Redaction.** Upstream errors and MCP tool errors pass through `redactSecret`, so a HyperDX key is replaced with `***`.
- **No header logging.** Do not add middleware that logs all request headers. `wrangler tail` only receives the redacted error message.
- **HTTPS.** Custom `X-HyperDX-Api-Url` values must use HTTPS. The default `HYPERDX_API_URL` must use HTTPS outside localhost.
- **CORS is not authentication.** It only controls browser access. The HyperDX key or gate token is the authentication layer.
- **Rate limiting.** If the endpoint is public, add a Cloudflare WAF rate-limiting rule for `/mcp`. Unauthenticated requests fail before HyperDX is called, but they still consume Worker requests.
- **Key scope.** Use a read-only HyperDX Personal API Access Key. The Worker never needs write access.

## Limits

The HyperDX external API (v1) has no raw log row search. Error groups are aggregated by `service`, `body`, and `trace_id` via `POST /api/v1/charts/series`. Time windows are limited to 90 days. `event_series` returns at most 10,000 points; `find_error_groups` at most 500 groups; dashboard and metric listings are capped to keep responses bounded.
