// Per-request authentication and configuration for the remote MCP server.
//
// The Worker is multi-tenant by design: each caller supplies their own HyperDX
// Personal API key, so every user sees only the data their HyperDX account can
// access. A shared server-side key is supported as an opt-in fallback, but only
// when an access gate token is also configured.

export interface Env {
  /** HyperDX API base URL. Defaults to https://api.hyperdx.io. */
  HYPERDX_API_URL?: string;
  /** Optional shared fallback key. Requires MCP_ACCESS_TOKEN. */
  HYPERDX_API_KEY?: string;
  /** Optional org-wide gate token checked via X-MCP-Access-Token. */
  MCP_ACCESS_TOKEN?: string;
  /** Comma-separated hostnames allowed in X-HyperDX-Api-Url (self-hosted HyperDX). */
  HYPERDX_ALLOWED_HOSTS?: string;
  /** Comma-separated custom hostnames for explicit Host validation. */
  MCP_ALLOWED_HOSTNAMES?: string;
  /** Comma-separated browser origins/hostnames allowed by CORS. Default: *. */
  CORS_ORIGINS?: string;
}

export interface AuthProps {
  apiKey: string;
  baseUrl: string;
  keySource: 'request' | 'shared';
}

export type AuthResult = { props: AuthProps } | { response: Response };

const DEFAULT_BASE_URL = 'https://api.hyperdx.io';
const KEY_MAX_LENGTH = 512;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function parseList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Accept `example.com`, `https://example.com`, or a full origin and return a
 * lowercase hostname. The MCP handler compares hostnames without scheme/port.
 */
export function parseHostnames(value?: string): string[] {
  return parseList(value)
    .map((entry) => {
      if (entry === '*') return '*';
      try {
        return new URL(entry.includes('://') ? entry : `https://${entry}`).hostname.toLowerCase();
      } catch {
        return entry.toLowerCase();
      }
    })
    .filter(Boolean);
}

export function corsOriginHostnames(env: Env): string[] | '*' | undefined {
  const allowed = parseHostnames(env.CORS_ORIGINS);
  if (!allowed.length) return undefined;
  return allowed.includes('*') ? '*' : allowed;
}

export function allowedHostnames(env: Env): string[] | undefined {
  const allowed = parseHostnames(env.MCP_ALLOWED_HOSTNAMES).filter((host) => host !== '*');
  return allowed.length ? allowed : undefined;
}

export function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const allowed = parseHostnames(env.CORS_ORIGINS);
  const origin = request.headers.get('Origin');

  if (!allowed.length || allowed.includes('*')) {
    headers.set('Access-Control-Allow-Origin', '*');
  } else if (origin) {
    let hostname = '';
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      // Opaque or malformed Origin: leave CORS headers off.
    }
    if (hostname && allowed.includes(hostname)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.append('Vary', 'Origin');
    }
  }

  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    [
      'Authorization',
      'Content-Type',
      'Accept',
      'X-HyperDX-Api-Key',
      'X-HyperDX-Api-Url',
      'X-MCP-Access-Token',
      'CF-Access-Client-Id',
      'CF-Access-Client-Secret',
      'MCP-Protocol-Version',
      'Mcp-Session-Id',
      'Last-Event-ID',
    ].join(', '),
  );
  headers.set('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

function jsonError(status: number, message: string, headers?: Headers): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Referrer-Policy', 'no-referrer');
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: responseHeaders,
  });
}

function readApiKey(request: Request): string | null {
  const explicit = request.headers.get('x-hyperdx-api-key')?.trim();
  if (explicit) return explicit;

  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}

async function safeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function resolveBaseUrl(request: Request, env: Env, cors: Headers): string | Response {
  const headerUrl = request.headers.get('x-hyperdx-api-url')?.trim();

  if (headerUrl) {
    let url: URL;
    try {
      url = new URL(headerUrl);
    } catch {
      return jsonError(400, 'X-HyperDX-Api-Url must be a valid URL.', cors);
    }
    if (url.protocol !== 'https:') {
      return jsonError(400, 'X-HyperDX-Api-Url must use https.', cors);
    }
    if (url.username || url.password) {
      return jsonError(400, 'X-HyperDX-Api-Url must not include credentials.', cors);
    }

    const allowed = parseHostnames(env.HYPERDX_ALLOWED_HOSTS);
    if (!allowed.includes(url.hostname.toLowerCase())) {
      return jsonError(
        403,
        `X-HyperDX-Api-Url host "${url.hostname}" is not allowlisted. Set HYPERDX_ALLOWED_HOSTS on the Worker to allow self-hosted HyperDX.`,
        cors,
      );
    }

    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  }

  const configured = env.HYPERDX_API_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return jsonError(500, 'Server misconfigured: HYPERDX_API_URL is not a valid URL.', cors);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return jsonError(500, 'Server misconfigured: HYPERDX_API_URL must use http or https.', cors);
  }
  if (url.username || url.password) {
    return jsonError(500, 'Server misconfigured: HYPERDX_API_URL must not include credentials.', cors);
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())) {
    return jsonError(500, 'Server misconfigured: HYPERDX_API_URL must use https outside localhost.', cors);
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const cors = corsHeaders(request, env);
  const gateToken = env.MCP_ACCESS_TOKEN?.trim();

  // The gate is checked first so unauthenticated traffic never reaches HyperDX.
  if (gateToken) {
    const suppliedGate = request.headers.get('x-mcp-access-token')?.trim() || '';
    if (!(await safeEqual(suppliedGate, gateToken))) {
      return {
        response: jsonError(401, 'Unauthorized: missing or invalid X-MCP-Access-Token header.', cors),
      };
    }
  }

  const requestKey = readApiKey(request);
  const sharedKey = env.HYPERDX_API_KEY?.trim();

  if (!requestKey && sharedKey && !gateToken) {
    return {
      response: jsonError(
        500,
        'Server misconfigured: HYPERDX_API_KEY is set without MCP_ACCESS_TOKEN. Set an access gate or remove the shared key and use per-user keys.',
        cors,
      ),
    };
  }

  const apiKey = requestKey || sharedKey;
  if (!apiKey) {
    return {
      response: jsonError(
        401,
        'Missing HyperDX API key. Configure your MCP client with "Authorization: Bearer <HYPERDX_API_KEY>" or "X-HyperDX-Api-Key: <HYPERDX_API_KEY>".',
        cors,
      ),
    };
  }

  if (apiKey.length > KEY_MAX_LENGTH || !/^[\x21-\x7E]+$/.test(apiKey)) {
    return { response: jsonError(401, 'Invalid HyperDX API key format.', cors) };
  }

  const baseUrl = resolveBaseUrl(request, env, cors);
  if (baseUrl instanceof Response) return { response: baseUrl };

  return {
    props: {
      apiKey,
      baseUrl,
      keySource: requestKey ? 'request' : 'shared',
    },
  };
}
