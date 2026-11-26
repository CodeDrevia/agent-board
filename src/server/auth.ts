/**
 * Who may use the board (DRV-550): members of one Drevia ID (Authentik) group,
 * `board-users` by default. Same shape as CodeDrevia/recipes (auth.py + oauth.py).
 *
 * Three ways in, all checked here:
 *
 *  * Web pages and /api from the browser: OpenID Connect code flow with PKCE (S256),
 *    a fresh state and nonce kept in a short-lived HMAC-signed cookie. The ID token is
 *    verified (RS256, issuer, audience, expiry, nonce) and its `groups` must name the
 *    group. The session is a random id in an HttpOnly cookie; SQLite keeps only its
 *    SHA-256. Every RECHECK_MS the session is refreshed at Drevia ID; a refused refresh
 *    or a token without the group ends it, so a removed user is out within minutes.
 *    Drevia ID unreachable: the session lives on for GRACE_MS after the last yes.
 *    CSRF: cookie-authenticated writes must send the session's token in X-XSRF-TOKEN
 *    (Angular's HttpClient does it from the XSRF-TOKEN cookie) and no foreign Origin.
 *  * /mcp from ChatGPT: an OAuth access token minted by Drevia ID for this app's own
 *    client (audience), carrying the board scope and the group. RFC 9728 metadata at
 *    /.well-known/oauth-protected-resource/mcp; every 401 points at it.
 *  * Scripts and the orchestrator: a static bearer token (AGENT_BOARD_API_TOKEN, 32+
 *    characters) on /api and /mcp.
 *
 * Fails closed: nothing configured means nobody gets in (except /api/health). The only
 * way to run open is AGENT_BOARD_AUTH=off, meant for a laptop on localhost.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { db, now } from './db';

export const SESSION_COOKIE = 'board_session';
export const XSRF_COOKIE = 'XSRF-TOKEN';
export const XSRF_HEADER = 'x-xsrf-token';
const FLOW_COOKIE = 'board_oidc';
const FLOW_MAX_AGE_S = 600;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RECHECK_MS = 10 * 60 * 1000;
const GRACE_MS = 60 * 60 * 1000;
const SESSION_KEY_MIN = 32;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
export const USER_AGENT = 'agent-board (+https://github.com/CodeDrevia/agent-board)';

/** Who made a request. `name` is what the board records as the actor. */
export interface Principal {
  kind: 'web' | 'oauth' | 'token' | 'open';
  sub: string;
  name: string;
  /** Web sessions only: the CSRF token writes must echo. */
  csrf?: string;
}

export class Unavailable extends Error {}
export class Refused extends Error {}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export interface AuthConfig {
  disabled: boolean;
  baseUrl: string;
  group: string;
  sessionKey: string;
  webIssuer: string;
  webClientId: string;
  webClientSecret: string;
  oauthIssuer: string;
  oauthClientId: string;
  oauthScope: string;
  apiToken: string;
  apiTokenName: string;
}

export function readConfig(): AuthConfig {
  const rawScope = process.env['AGENT_BOARD_OAUTH_SCOPE'];
  return {
    disabled: env('AGENT_BOARD_AUTH').toLowerCase() === 'off',
    baseUrl: env('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    group: env('AGENT_BOARD_REQUIRED_GROUP') || 'board-users',
    sessionKey: env('SESSION_KEY'),
    webIssuer: env('AGENT_BOARD_WEB_ISSUER'),
    webClientId: env('AGENT_BOARD_WEB_CLIENT_ID'),
    webClientSecret: env('AGENT_BOARD_WEB_CLIENT_SECRET'),
    oauthIssuer: env('AGENT_BOARD_OAUTH_ISSUER'),
    oauthClientId: env('AGENT_BOARD_OAUTH_CLIENT_ID'),
    oauthScope: rawScope === undefined ? 'agent-board' : rawScope.trim(),
    apiToken: env('AGENT_BOARD_API_TOKEN'),
    apiTokenName: env('AGENT_BOARD_API_TOKEN_NAME') || 'orchestrator',
  };
}

let config = readConfig();

/** Re-read the environment (tests). */
export function reloadAuthConfig(): AuthConfig {
  config = readConfig();
  discoveryCache.clear();
  jwksCache.clear();
  return config;
}

export function secureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  } catch {
    return false;
  }
}

/** → null when web sign-in can work, else why not (for the log and the error page). */
export function webProblem(c: AuthConfig = config): string | null {
  const missing = (
    [
      ['AGENT_BOARD_WEB_ISSUER', c.webIssuer],
      ['AGENT_BOARD_WEB_CLIENT_ID', c.webClientId],
      ['AGENT_BOARD_WEB_CLIENT_SECRET', c.webClientSecret],
      ['PUBLIC_BASE_URL', c.baseUrl],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) return `${missing.join(', ')} not set`;
  if (c.sessionKey.length < SESSION_KEY_MIN)
    return `SESSION_KEY missing or shorter than ${SESSION_KEY_MIN} characters`;
  if (!secureUrl(c.webIssuer)) return 'AGENT_BOARD_WEB_ISSUER must be https';
  return null;
}

export function oauthProblem(c: AuthConfig = config): string | null {
  if (!c.oauthIssuer || !c.oauthClientId)
    return 'AGENT_BOARD_OAUTH_ISSUER and AGENT_BOARD_OAUTH_CLIENT_ID not set';
  if (!secureUrl(c.oauthIssuer)) return 'AGENT_BOARD_OAUTH_ISSUER must be https';
  if (!c.baseUrl) return 'PUBLIC_BASE_URL not set';
  return null;
}

function apiTokenUsable(c: AuthConfig = config): boolean {
  return c.apiToken.length >= 32;
}

/** One line per way in, logged at start so a misconfiguration is visible. */
export function describeAuth(): string {
  if (config.disabled) return 'auth: OFF (AGENT_BOARD_AUTH=off) - anyone who reaches the port is in';
  return [
    `auth: group ${config.group}`,
    `web sign-in ${webProblem() ?? 'on'}`,
    `mcp oauth ${oauthProblem() ?? 'on'}`,
    `api token ${apiTokenUsable() ? 'on' : 'off'}`,
  ].join('; ');
}

// --------------------------------------------------------------------------- small helpers
const b64url = (buf: Buffer): string => buf.toString('base64url');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Only a path on this site: never an absolute URL, //host or a backslash trick. */
export function safeNext(next: unknown): string {
  if (
    typeof next !== 'string' ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    next.includes('\\') ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(next)
  )
    return '/';
  return next;
}

function secureCookies(): boolean {
  return config.baseUrl.startsWith('https://');
}

async function fetchJson(url: string, form?: Record<string, string>): Promise<unknown> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
  let body: string | undefined;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: form ? 'POST' : 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Unavailable(`${url}: ${String(error)}`);
  }
  if (!res.ok) {
    // A 4xx from the token endpoint is a refused grant, not an outage.
    if (form && res.status >= 400 && res.status < 500)
      throw new Refused(`token endpoint said ${res.status}`);
    throw new Unavailable(`${url} answered ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Unavailable(`${url} answered something that is not JSON`);
  }
}

// --------------------------------------------------------------------------- discovery + keys
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discovery(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;
  const doc = (await fetchJson(
    `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
  )) as Partial<Discovery>;
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[k] !== 'string' || !secureUrl(doc[k]!))
      throw new Unavailable(`discovery document has no usable ${k}`);
  }
  if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, ''))
    throw new Unavailable('discovery names another issuer');
  discoveryCache.set(issuer, { doc: doc as Discovery, at: Date.now() });
  return doc as Discovery;
}

async function keysFor(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  let keys = jwksCache.get(issuer);
  if (!keys) {
    const { jwks_uri } = await discovery(issuer);
    keys = createRemoteJWKSet(new URL(jwks_uri), {
      timeoutDuration: HTTP_TIMEOUT_MS,
      cooldownDuration: 60_000,
      cacheMaxAge: DISCOVERY_TTL_MS,
      // Cloudflare in front of Drevia ID refuses some default user agents.
      headers: { 'User-Agent': USER_AGENT },
    });
    jwksCache.set(issuer, keys);
  }
  return keys;
}

async function verifyJwt(token: string, issuer: string, audience: string): Promise<JWTPayload> {
  const doc = await discovery(issuer);
  const keys = await keysFor(issuer);
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: doc.issuer,
      audience,
      algorithms: ['RS256'],
      clockTolerance: 60,
      requiredClaims: ['exp', 'iat', 'iss', 'aud', 'sub'],
    });
    return payload;
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'ERR_JWKS_TIMEOUT' || /fetch|network|ECONN/i.test(String(error)))
      throw new Unavailable(`key set unreachable: ${String(error)}`);
    throw new Refused(`token: ${code || String(error)}`);
  }
}

/** Why these claims are not a board user, or null: a subject, and `groups` naming the group. */
export function notAllowed(claims: JWTPayload, group: string): string | null {
  const sub = claims.sub;
  if (typeof sub !== 'string' || !sub.trim() || sub.length > 255) return 'no usable subject';
  const groups = (claims as { groups?: unknown }).groups;
  if (!group || !Array.isArray(groups) || !groups.some((g) => g === group))
    return `not in group ${group}`;
  return null;
}

function displayName(claims: JWTPayload): string {
  const c = claims as Record<string, unknown>;
  for (const k of ['preferred_username', 'nickname', 'name']) {
    const v = c[k];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase().slice(0, 64);
  }
  return `user-${String(claims.sub)}`;
}

// --------------------------------------------------------------------------- MCP / API bearer
/** Verify a ChatGPT access token. Exported for tests. */
export async function verifyAccessToken(token: string): Promise<Principal> {
  const claims = await verifyJwt(token, config.oauthIssuer, config.oauthClientId);
  // An ID token for the same client has the same iss/aud/sub but no `scope`: the scope
  // claim is what makes this an access token.
  const granted = (claims as { scope?: unknown }).scope;
  const names =
    typeof granted === 'string'
      ? granted.split(/\s+/).filter(Boolean)
      : Array.isArray(granted) && granted.every((x) => typeof x === 'string')
        ? (granted as string[])
        : null;
  if (!names || names.length === 0) throw new Refused('no usable scope claim');
  if (config.oauthScope && !names.includes(config.oauthScope))
    throw new Refused(`scope ${config.oauthScope} not granted`);
  const why = notAllowed(claims, config.group);
  if (why) throw new Refused(why);
  return { kind: 'oauth', sub: String(claims.sub).trim(), name: displayName(claims) };
}

async function bearerPrincipal(token: string): Promise<Principal | 'unavailable' | null> {
  if (apiTokenUsable() && safeEqual(token, config.apiToken)) {
    return { kind: 'token', sub: `token:${config.apiTokenName}`, name: config.apiTokenName };
  }
  if (oauthProblem()) return null;
  try {
    return await verifyAccessToken(token);
  } catch (error) {
    if (error instanceof Unavailable) {
      console.warn('auth: Drevia ID unavailable for a bearer token:', error.message);
      return 'unavailable';
    }
    console.info('auth: bearer refused:', (error as Error).message);
    return null;
  }
}

// --------------------------------------------------------------------------- refresh token at rest
function sealKey(): Buffer {
  return createHash('sha256').update(`agent-board-refresh:${config.sessionKey}`).digest();
}

function seal(token: string | null): string | null {
  if (!token) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv);
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return b64url(Buffer.concat([iv, c.getAuthTag(), enc]));
}

function unseal(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const d = createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null; // SESSION_KEY rotated: sign in again
  }
}

// --------------------------------------------------------------------------- flow cookie
interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  at: number;
}

function flowMac(body: string): string {
  return createHmac('sha256', config.sessionKey).update(`board-oidc:${body}`).digest('hex');
}

function signFlow(flow: Flow): string {
  const body = b64url(Buffer.from(JSON.stringify(flow)));
  return `${body}.${flowMac(body)}`;
}

function readFlow(value: string | undefined): Flow | null {
  if (!value || !value.includes('.') || webProblem()) return null;
  const i = value.lastIndexOf('.');
  const body = value.slice(0, i);
  if (!safeEqual(value.slice(i + 1), flowMac(body))) return null;
  try {
    const flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Flow;
    if (typeof flow.at !== 'number' || flow.at + FLOW_MAX_AGE_S < Date.now() / 1000) return null;
    return flow;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- sessions
interface SessionRow {
  id_hash: string;
  sub: string;
  username: string;
  csrf: string;
  refresh_token: string | null;
  created_at: number;
  expires_at: number;
  checked_at: number;
  confirmed_at: number;
}

const checking = new Set<string>();

async function tokens(form: Record<string, string>): Promise<{ claims: JWTPayload; refresh: string | null }> {
  const doc = await discovery(config.webIssuer);
  const res = (await fetchJson(doc.token_endpoint, {
    ...form,
    client_id: config.webClientId,
    client_secret: config.webClientSecret,
  })) as { id_token?: unknown; refresh_token?: unknown };
  if (typeof res?.id_token !== 'string') throw new Refused('no id_token in the token response');
  const claims = await verifyJwt(res.id_token, config.webIssuer, config.webClientId);
  const refresh = typeof res.refresh_token === 'string' && res.refresh_token ? res.refresh_token : null;
  return { claims, refresh };
}

async function sessionPrincipal(req: Request): Promise<Principal | null> {
  if (webProblem()) return null;
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sid || sid.length > 200) return null;
  const idHash = sha256(sid);
  const row = db().prepare(`SELECT * FROM web_sessions WHERE id_hash = ?`).get(idHash) as
    | SessionRow
    | undefined;
  const t = now();
  if (!row || row.expires_at < t) {
    if (row) db().prepare(`DELETE FROM web_sessions WHERE id_hash = ?`).run(idHash);
    return null;
  }
  const principal: Principal = { kind: 'web', sub: row.sub, name: row.username, csrf: row.csrf };
  if (t - row.checked_at < RECHECK_MS) {
    return t - row.confirmed_at < RECHECK_MS + GRACE_MS ? principal : null;
  }
  if (checking.has(idHash)) {
    // Another request is asking Drevia ID right now; carry on meanwhile.
    return t - row.confirmed_at < RECHECK_MS + GRACE_MS ? principal : null;
  }
  checking.add(idHash);
  try {
    db().prepare(`UPDATE web_sessions SET checked_at = ? WHERE id_hash = ?`).run(t, idHash);
    const refresh = unseal(row.refresh_token);
    if (!refresh) {
      console.info('auth: session has no usable refresh token; ended');
      db().prepare(`DELETE FROM web_sessions WHERE id_hash = ?`).run(idHash);
      return null;
    }
    let result;
    try {
      result = await tokens({ grant_type: 'refresh_token', refresh_token: refresh });
    } catch (error) {
      if (error instanceof Unavailable) {
        if (t - row.confirmed_at < GRACE_MS) {
          console.warn('auth: Drevia ID unavailable for the re-check; grace:', error.message);
          return principal;
        }
        console.warn('auth: Drevia ID unavailable past the grace period:', error.message);
        return null;
      }
      console.info('auth: Drevia ID refused the session refresh; ended:', (error as Error).message);
      db().prepare(`DELETE FROM web_sessions WHERE id_hash = ?`).run(idHash);
      return null;
    }
    let why = notAllowed(result.claims, config.group);
    if (!why && String(result.claims.sub) !== row.sub) why = 'the refreshed token names another subject';
    if (why) {
      console.info(`auth: session no longer allowed (${why}); ended`);
      db().prepare(`DELETE FROM web_sessions WHERE id_hash = ?`).run(idHash);
      return null;
    }
    db()
      .prepare(`UPDATE web_sessions SET confirmed_at = ?, refresh_token = ? WHERE id_hash = ?`)
      .run(now(), seal(result.refresh ?? refresh), idHash);
    return principal;
  } finally {
    checking.delete(idHash);
  }
}

// --------------------------------------------------------------------------- principal + gates
const PRINCIPAL = Symbol('principal');

/** Resolve who is calling. Bearer first, then the session cookie. */
export async function principalOf(req: Request): Promise<Principal | 'unavailable' | null> {
  const cached = (req as unknown as Record<symbol, Principal | undefined>)[PRINCIPAL];
  if (cached) return cached;
  let p: Principal | 'unavailable' | null = null;
  if (config.disabled) {
    p = { kind: 'open', sub: 'open', name: '' };
  } else {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S{1,8192})$/i.exec(header);
    p = m ? await bearerPrincipal(m[1]) : await sessionPrincipal(req);
  }
  if (p && p !== 'unavailable') (req as unknown as Record<symbol, Principal>)[PRINCIPAL] = p;
  return p;
}

/** The principal a gate has already let through. */
export function principal(res: Response): Principal {
  return res.locals['principal'] as Principal;
}

/**
 * The name board actions are recorded under. Humans on the web and ChatGPT act as
 * themselves (their Drevia ID username); the static token may name any agent, as
 * the CLI and Claude Code sessions always have.
 */
export function actorFor(p: Principal, requested?: unknown): string {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  if (p.kind === 'token' || p.kind === 'open') return asked || p.name || 'human';
  return p.name;
}

/**
 * `actorFor` without the fallback: a token or open caller must name itself, so
 * callers that all share the token's name cannot pass for one another.
 */
export function explicitActorFor(p: Principal, requested?: unknown): string | null {
  const asked = typeof requested === 'string' ? requested.trim() : '';
  if (p.kind === 'token' || p.kind === 'open') return asked || null;
  return p.name;
}

function writeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method);
}

function csrfOk(req: Request, p: Principal): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && origin.replace(/\/+$/, '') !== config.baseUrl) return false;
  const sent = String(req.headers[XSRF_HEADER] ?? '');
  return !!sent && !!p.csrf && safeEqual(sent, p.csrf);
}

/** Gate for /api: 401/403/503 JSON. */
export function requireApi() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const p = await principalOf(req);
      if (p === 'unavailable') {
        res.status(503).json({ error: 'sign-in service unavailable' });
        return;
      }
      if (!p) {
        res.status(401).json({ error: 'sign in required', login: '/auth/login' });
        return;
      }
      if (p.kind === 'web' && writeMethod(req.method) && !csrfOk(req, p)) {
        res.status(403).json({ error: 'missing or wrong CSRF token' });
        return;
      }
      res.locals['principal'] = p;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function resourceMetadataUrl(): string {
  return `${config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
}

/** Gate for /mcp: bearer only (no cookies), 401 points ChatGPT at Drevia ID. */
export function requireMcp() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      let p: Principal | 'unavailable' | null;
      if (config.disabled) p = { kind: 'open', sub: 'open', name: '' };
      else {
        const m = /^Bearer\s+(\S{1,8192})$/i.exec(req.headers.authorization ?? '');
        p = m ? await bearerPrincipal(m[1]) : null;
      }
      if (p === 'unavailable') {
        res.status(503).json({ error: 'sign-in service unavailable' });
        return;
      }
      if (!p) {
        if (!oauthProblem()) {
          const scope = config.oauthScope ? `, scope="${config.oauthScope}"` : '';
          res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${resourceMetadataUrl()}"${scope}`,
          );
        }
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.locals['principal'] = p;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Gate for pages: redirect to sign-in. Static assets of the app shell stay behind it too. */
export function requirePage() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const p = await principalOf(req);
      if (p && p !== 'unavailable') {
        res.locals['principal'] = p;
        next();
        return;
      }
      if (p === 'unavailable') {
        res.status(503).type('text/plain').send('Drevia ID is unreachable. Try again shortly.');
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.status(401).type('text/plain').send('Sign in required.');
        return;
      }
      res.redirect(302, `/auth/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
    } catch (error) {
      next(error);
    }
  };
}

// --------------------------------------------------------------------------- routes
function cookie(name: string, value: string, opts: { maxAgeS: number; path: string; httpOnly: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeS}`,
    `Path=${opts.path}`,
    'SameSite=Lax',
  ];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (secureCookies()) parts.push('Secure');
  return parts.join('; ');
}

function errorPage(res: Response, status: number, text: string): void {
  res
    .status(status)
    .type('text/html')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Agent Board</title>` +
        `<p>${text}</p><p><a href="/auth/login">Try again</a></p>`,
    );
}

/** /auth/login, /auth/callback, /auth/logout and the OAuth discovery documents. */
export function createAuthRouter(): Router {
  const r = Router();

  r.get('/.well-known/oauth-protected-resource{/mcp}', (_req, res) => {
    if (oauthProblem()) {
      res.status(404).json({ error: 'oauth not configured' });
      return;
    }
    res.json({
      resource: `${config.baseUrl}/mcp`,
      authorization_servers: [config.oauthIssuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Agent Board',
      ...(config.oauthScope ? { scopes_supported: [config.oauthScope] } : {}),
    });
  });

  r.get('/auth/login', async (req, res) => {
    const why = webProblem();
    if (why) {
      console.warn(`auth: web sign-in not configured (${why})`);
      errorPage(res, 503, 'Sign-in is not configured on this server.');
      return;
    }
    try {
      const flow: Flow = {
        state: b64url(randomBytes(24)),
        nonce: b64url(randomBytes(24)),
        verifier: b64url(randomBytes(48)),
        next: safeNext(req.query['next']),
        at: Math.floor(Date.now() / 1000),
      };
      const doc = await discovery(config.webIssuer);
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: config.webClientId,
        redirect_uri: `${config.baseUrl}/auth/callback`,
        // profile carries `groups`; offline_access the refresh token for the re-check.
        scope: 'openid profile offline_access',
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: b64url(createHash('sha256').update(flow.verifier).digest()),
        code_challenge_method: 'S256',
      });
      res.setHeader(
        'Set-Cookie',
        cookie(FLOW_COOKIE, signFlow(flow), { maxAgeS: FLOW_MAX_AGE_S, path: '/auth', httpOnly: true }),
      );
      res.redirect(302, `${doc.authorization_endpoint}?${q.toString()}`);
    } catch (error) {
      console.warn('auth: login could not start:', (error as Error).message);
      errorPage(res, 503, 'Drevia ID is unreachable. Try again shortly.');
    }
  });

  r.get('/auth/callback', async (req, res) => {
    const clearFlow = cookie(FLOW_COOKIE, '', { maxAgeS: 0, path: '/auth', httpOnly: true });
    try {
      if (webProblem()) throw new Refused('sign-in is not configured');
      const flow = readFlow(parseCookies(req.headers.cookie)[FLOW_COOKIE]);
      if (!flow) throw new Refused('no or expired sign-in in progress');
      const state = String(req.query['state'] ?? '');
      if (!state || !safeEqual(state, flow.state)) throw new Refused('state does not match');
      const code = String(req.query['code'] ?? '');
      if (!code) throw new Refused('no code');
      const { claims, refresh } = await tokens({
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${config.baseUrl}/auth/callback`,
        code_verifier: flow.verifier,
      });
      const nonce = (claims as { nonce?: unknown }).nonce;
      if (typeof nonce !== 'string' || !safeEqual(nonce, flow.nonce)) throw new Refused('nonce does not match');
      const why = notAllowed(claims, config.group);
      if (why) throw new Refused(why);
      if (!refresh) console.warn('auth: no refresh token issued; the session ends at its first re-check');
      const sid = b64url(randomBytes(32));
      const csrf = b64url(randomBytes(32));
      const t = now();
      db()
        .prepare(
          `INSERT INTO web_sessions (id_hash, sub, username, csrf, refresh_token, created_at,
                                     expires_at, checked_at, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sha256(sid), String(claims.sub).trim(), displayName(claims), csrf, seal(refresh), t,
          t + SESSION_MAX_AGE_MS, t, t);
      db().prepare(`DELETE FROM web_sessions WHERE expires_at < ?`).run(t);
      res.setHeader('Set-Cookie', [
        clearFlow,
        cookie(SESSION_COOKIE, sid, { maxAgeS: SESSION_MAX_AGE_MS / 1000, path: '/', httpOnly: true }),
        // Readable by the page on purpose: Angular echoes it in X-XSRF-TOKEN.
        cookie(XSRF_COOKIE, csrf, { maxAgeS: SESSION_MAX_AGE_MS / 1000, path: '/', httpOnly: false }),
      ]);
      res.redirect(302, safeNext(flow.next));
    } catch (error) {
      res.setHeader('Set-Cookie', clearFlow);
      if (error instanceof Unavailable) {
        console.warn('auth: callback, Drevia ID unavailable:', error.message);
        errorPage(res, 503, 'Drevia ID is unreachable. Try again shortly.');
        return;
      }
      console.info('auth: sign-in refused:', (error as Error).message);
      errorPage(res, 403, 'This account may not use the board.');
    }
  });

  r.post('/auth/logout', async (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const clear = [
      cookie(SESSION_COOKIE, '', { maxAgeS: 0, path: '/', httpOnly: true }),
      cookie(XSRF_COOKIE, '', { maxAgeS: 0, path: '/', httpOnly: false }),
    ];
    if (sid && sid.length <= 200 && !webProblem()) {
      const idHash = sha256(sid);
      const row = db().prepare(`SELECT * FROM web_sessions WHERE id_hash = ?`).get(idHash) as
        | SessionRow
        | undefined;
      // Only the page itself may log out (CSRF), but a wrong token just keeps the session.
      if (row && safeEqual(String(req.headers[XSRF_HEADER] ?? ''), row.csrf)) {
        db().prepare(`DELETE FROM web_sessions WHERE id_hash = ?`).run(idHash);
        const token = unseal(row.refresh_token);
        if (token) {
          try {
            const doc = await discovery(config.webIssuer);
            if (doc.revocation_endpoint && secureUrl(doc.revocation_endpoint)) {
              const answer = await fetch(doc.revocation_endpoint, {
                method: 'POST',
                headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  token,
                  token_type_hint: 'refresh_token',
                  client_id: config.webClientId,
                  client_secret: config.webClientSecret,
                }).toString(),
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
              });
              console.info(`auth: logout, revocation answered ${answer.status}`);
            }
          } catch (error) {
            console.warn('auth: logout ended the local session, revocation failed:', String(error));
          }
        }
      } else {
        res.status(403).json({ error: 'missing or wrong CSRF token' });
        return;
      }
    }
    res.setHeader('Set-Cookie', clear);
    res.json({ ok: true });
  });

  return r;
}

/** Hostname of PUBLIC_BASE_URL, for host allow-lists. */
export function publicHostname(): string | null {
  try {
    return config.baseUrl ? new URL(config.baseUrl).hostname : null;
  } catch {
    return null;
  }
}
