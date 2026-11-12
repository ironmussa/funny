/**
 * HTTP composition of the central server: middleware, public and authenticated
 * routes, and the runner proxy catch-all. Host-independent — it does not
 * listen, serve files from disk, or touch the process (docs/plans/
 * cloudflare-portability.md, Phase 1). A host (`hosts/bun/`) builds it after
 * initializing the database and auth, and mounts its own assets after it.
 */

import { createHash } from 'crypto';

import { VISUALIZER_IMPORT_MAP_JSON } from '@funny/shared/visualizer-importmap';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { clientIp, REVERSE_LINK_CALLER_ADDRESS } from './lib/client-ip.js';
import {
  MCP_OAUTH_CALLBACK_CSP,
  MCP_OAUTH_CALLBACK_SCRIPT,
} from './lib/mcp-oauth-callback-page.js';
import { sandboxAttachmentResponse } from './lib/runner-content-policy.js';
import type { ServerEnv } from './lib/types.js';
import { authMiddleware, setAuthInstance } from './middleware/auth.js';

// CSP source expression for the inline visualizer import map (see secureHeaders
// below). Computed from the exact bytes the client injects, so the policy always
// matches the page.
const VISUALIZER_IMPORT_MAP_CSP_HASH = `'sha256-${createHash('sha256')
  .update(VISUALIZER_IMPORT_MAP_JSON, 'utf8')
  .digest('base64')}'`;

export interface ServerAppOptions {
  /**
   * The initialized Better Auth instance. `any` because the runtime and server
   * auth instances have slightly different types (different access control
   * statements, different plugin configurations).
   */
  authInstance: any;
  corsOrigins: string[];
  /**
   * Host-specific routes registered after the API (client bundle, extension
   * assets). Registered last so they never shadow an API route.
   */
  mountAssets?: (app: Hono<ServerEnv>) => void | Promise<void>;
}

export async function createServerApp(opts: ServerAppOptions): Promise<Hono<ServerEnv>> {
  const { authInstance, corsOrigins } = opts;
  setAuthInstance(authInstance);

  const app = new Hono<ServerEnv>();

  // Middleware
  app.use('*', cors({ origin: corsOrigins, credentials: true }));
  // Security HI-7: defense-in-depth on top of `SameSite=Strict` session cookies.
  // `csrf()` blocks form-submittable POSTs (form-urlencoded / multipart /
  // text/plain — the CORS-"simple" content types that browsers send cross-
  // origin WITHOUT preflight) unless the Origin matches the allowlist. JSON
  // requests are unaffected because they require CORS preflight and so are
  // already gated by the same allowlist via the `cors()` middleware above.
  // Runner/scheduler/proxy traffic is JSON-only, so this is invisible to
  // them.
  app.use('*', csrf({ origin: corsOrigins }));
  // These two run their post-`next()` code AFTER `secureHeaders` below (they are
  // registered before it, so they wrap it); registered after it, their headers
  // would be overwritten by the global CSP/COOP.
  //
  // Security HI-10: CSP/COOP for the MCP OAuth callback page and its script.
  // The server renders both itself (`lib/mcp-oauth-callback-page.ts`; runner
  // HTML is never relayed — H3). No inline script, so `script-src 'self'`, and
  // COOP `same-origin-allow-popups` keeps `window.opener` for the app window
  // that launched the popup while isolating the OAuth provider's page.
  app.use('/api/mcp/oauth/callback*', async (c, next) => {
    await next();
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    c.res.headers.set('Content-Security-Policy', MCP_OAUTH_CALLBACK_CSP);
  });
  // Security H3: a response forced to download (`Content-Disposition:
  // attachment`, e.g. runner content the proxy neutralized) is also sandboxed,
  // so even a browser that renders it gets an opaque origin and no scripts.
  app.use('/api/*', async (c, next) => {
    await next();
    sandboxAttachmentResponse(c.res.headers);
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // The inline `<script type="importmap">` injected into index.html (lets
        // full-trust visualizer plugins share the host's React) is allowed via a
        // SHA-256 hash of its exact contents — keeping script-src otherwise strict
        // ('self' only, no 'unsafe-inline'). The hash derives from the same
        // constant the client injects, so the two can never drift.
        // Satteri compiles WebAssembly; JavaScript eval remains prohibited.
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", VISUALIZER_IMPORT_MAP_CSP_HASH],
        // Monaco editor workers are bundled via Vite's `?worker` imports and
        // served from same-origin in prod; dev builds may use blob: URLs.
        workerSrc: ["'self'", 'blob:'],
        // Security M3 — known limitation. `'unsafe-inline'` is still required
        // here because the React SPA uses ~150 inline `style=` props plus
        // Radix UI primitives (popovers, tooltips, dropdowns) that compute
        // positioning inline at runtime. Eliminating it requires either:
        //   (a) migrating those sites to CSS classes / data-attr-driven CSS,
        //   (b) injecting a CSP nonce into the SPA's <style> sinks (Radix
        //       supports nonces but each component must be wrapped in a
        //       NonceProvider, and Vite must emit one per request),
        //   (c) accepting a per-request hash list, which Radix's dynamic
        //       positioning styles defeat.
        // Tracked in SECURITY_AUDIT_TASKS.md (M3). Script-side CSP remains
        // strict ('self' only) — inline-style XSS is significantly harder to
        // weaponize than inline-script XSS.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://avatars.githubusercontent.com'],
        // Security HI-9: `'self'` already authorises same-origin `ws://` /
        // `wss://` upgrades; the prior wildcard `ws:` / `wss:` allowed any
        // host and was a convenient exfil channel for a compromised script
        // (open a WebSocket to `wss://attacker.example` and stream session
        // contents). Cross-origin WebSocket targets must be added explicitly
        // by a future deployment that needs them (e.g. a remote analytics
        // collector) — keep the default closed.
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameSrc: ["'none'"],
      },
      // Satteri's WASM workers share memory, requiring cross-origin isolation.
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginEmbedderPolicy: 'require-corp',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      // Security L3: X-Content-Type-Options: nosniff — applied to every response
      // including the static client bundle served below, so a JS file uploaded
      // with the wrong extension (or a transpiled chunk mis-typed by the CDN)
      // cannot be executed as HTML/script via MIME sniffing. Set explicitly even
      // though Hono defaults to true, so a future upstream default change can't
      // silently regress this.
      xContentTypeOptions: true,
    }),
  );
  app.use('*', logger());

  // Health check (before auth)
  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // MCP OAuth callback script (public, static): the callback page is rendered by
  // the server and must never load a runner-supplied script (H3).
  app.get('/api/mcp/oauth/callback.js', (c) => {
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300');
    return c.body(MCP_OAUTH_CALLBACK_SCRIPT);
  });

  // Bootstrap endpoint (public — returns minimal info for client init)
  app.get('/api/bootstrap', (c) => {
    c.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    c.header('Pragma', 'no-cache');
    // packages/server is always the central/team server: it proxies to remote
    // per-user runners and never holds a Claude CLI itself. The client uses this
    // to skip runner-only onboarding steps (e.g. the Claude CLI check), which
    // make no sense during a server install — the onboarding user may be a
    // sysadmin who never runs a runner.
    return c.json({ mode: 'team' });
  });

  // ── Rate limiting on auth endpoints ───────────────────────
  const { rateLimit } = await import('./middleware/rate-limit.js');
  // Lenient limit for read-only session checks (get-session is polled after login)
  app.use('/api/auth/get-session', rateLimit({ windowMs: 60_000, max: 600 }));
  // Strict rate limit on auth credential mutations only (sign-in, sign-up).
  // Scoped narrowly so it does not block high-frequency reads like get-session.
  app.use('/api/auth/sign-in/*', rateLimit({ windowMs: 60_000, max: 60 }));
  app.use('/api/auth/sign-up/*', rateLimit({ windowMs: 60_000, max: 60 }));

  // Security HI-12: per-account login throttle — IP rate limiting alone does
  // not stop a distributed brute force against a single username/email.
  // `loginThrottleMiddleware` reads the identifier from the request body,
  // rejects 429 if it is currently locked, otherwise hands the request to
  // Better Auth and records failure/success based on the response status.
  const { loginThrottleMiddleware } = await import('./middleware/login-throttle.js');
  app.use('/api/auth/sign-in/*', loginThrottleMiddleware);
  // Generous catch-all for any other auth endpoints
  app.use('/api/auth/*', rateLimit({ windowMs: 60_000, max: 600 }));
  // Strict rate limit on invite link registration: 20 per minute per IP
  app.use('/api/invite-links/register', rateLimit({ windowMs: 60_000, max: 20 }));
  // Device-link enrollment is unauthenticated (start/poll/approve) — keep it
  // tight to blunt user-code brute force. Must precede the generous catch-all
  // below so the stricter limit wins for these paths.
  app.use('/api/runners/enroll/*', rateLimit({ windowMs: 60_000, max: 60, perUser: true }));
  // Runner endpoints are high-frequency (heartbeat + task polling) — give them a generous limit
  app.use('/api/runners/*', rateLimit({ windowMs: 60_000, max: 1200 }));

  // ── Public routes (before auth middleware) ────────────────
  const { inviteLinkPublicRoutes, inviteLinkRoutes } = await import('./routes/invite-links.js');
  app.route('/api/invite-links', inviteLinkPublicRoutes);

  // LLM credential proxy for sandbox agents (thread-sandboxes): authenticated by
  // the sandbox's proxy token, not a session, so it is mounted before auth.
  const { llmProxyRoutes } = await import('./routes/llm-proxy.js');
  // Per IP before the token is checked. Reverse-link callers all share one
  // address, so they skip this bucket; every sandbox is limited by its own
  // token inside the routes instead.
  app.use(
    '/api/llm-proxy/*',
    rateLimit({
      windowMs: 60_000,
      max: 600,
      skip: (c) => clientIp(c) === REVERSE_LINK_CALLER_ADDRESS,
    }),
  );
  app.route('/api/llm-proxy', llmProxyRoutes());

  // Better Auth routes — use app.all to handle all HTTP methods (GET, POST, DELETE, etc.)
  app.all('/api/auth/*', (c) => authInstance.handler(c.req.raw));

  // Auth middleware for all API routes
  app.use('/api/*', authMiddleware);

  // Browser-panel screencast frames are fetched by reference, one GET per frame:
  // a playing video means tens per second. They get their own bucket so the
  // panel can never use up the API limit and lock the rest of the UI out (429).
  const BROWSER_V1_RESOURCES_PREFIX = '/api/browser-v1/resources/';
  app.use(`${BROWSER_V1_RESOURCES_PREFIX}*`, rateLimit({ windowMs: 60_000, max: 6000 }));

  // Per-user rate limit on authenticated API endpoints (runs after auth so the
  // limiter can key off userId; otherwise every request looks anonymous).
  app.use(
    '/api/*',
    rateLimit({
      windowMs: 60_000,
      max: 1200,
      perUser: true,
      skip: (c) => c.req.path.startsWith(BROWSER_V1_RESOURCES_PREFIX),
    }),
  );

  // ── Server-managed data routes ───────────────────────────
  const { authRoutes } = await import('./routes/auth.js');
  const { projectRoutes } = await import('./routes/projects.js');
  const { runnerRoutes } = await import('./routes/runners.js');
  const { infraRoutes } = await import('./routes/infra.js');
  const { profileRoutes } = await import('./routes/profile.js');
  const { threadRoutes, requireThreadOwner, requireThreadSteer } =
    await import('./routes/threads.js');
  const { shareRoutes } = await import('./routes/thread-shares.js');
  const { removedAutomationRoutes } = await import('./routes/removed-rest.js');
  const { teamProjectRoutes } = await import('./routes/team-projects.js');
  const { teamSettingsRoutes } = await import('./routes/team-settings.js');
  const { pipelineRoutes } = await import('./routes/pipelines.js');
  const { schedulerRoutes } = await import('./routes/scheduler.js');
  const { schedulerSystemRoutes } = await import('./routes/scheduler-system.js');
  const { jobRoutes } = await import('./routes/jobs.js');
  const { refuseRetiredRestRoutes } = await import('./routes/retired-rest.js');
  const { userRoutes } = await import('./routes/users.js');
  const { mediaRoutes } = await import('./routes/media.js');
  const { browserV1ResourceRoutes } = await import('./routes/browser-v1-resources.js');

  app.route('/api/auth', authRoutes);
  app.route('/api/projects', projectRoutes);
  app.route('/api/users', userRoutes);
  app.route('/api/runners', runnerRoutes);
  app.route('/api/infra', infraRoutes());
  app.route('/api/media', mediaRoutes);
  app.route('/api/browser-v1/resources', browserV1ResourceRoutes);
  app.route('/api/profile', profileRoutes);
  // Share routes mounted BEFORE threadRoutes so `/api/threads/shared-with-me` and
  // `/:id/shares` are matched before the generic `/:id` pattern.
  app.route('/api/threads', shareRoutes);
  app.route('/api/threads', threadRoutes);
  // tRPC only now; answered 404 here so the path never reaches a runner.
  app.route('/api/automations', removedAutomationRoutes);
  const { githubAppSettingsRoutes } = await import('./routes/github-app-settings.js');
  app.route('/api/settings/github-app', githubAppSettingsRoutes());
  // REST groups now served over tRPC only (task 6.1): answer 404 instead of
  // letting them fall through to the runner proxy.
  refuseRetiredRestRoutes(app);
  app.route('/api/team-projects', teamProjectRoutes);
  app.route('/api/team-settings', teamSettingsRoutes);
  app.route('/api/pipelines', pipelineRoutes);
  app.route('/api/invite-links', inviteLinkRoutes);
  app.route('/api/jobs', jobRoutes);
  // System routes mounted FIRST so /api/scheduler/system/* matches them
  // before the user-scoped /api/scheduler/* tree.
  app.route('/api/scheduler/system', schedulerSystemRoutes);
  app.route('/api/scheduler', schedulerRoutes);

  const { extensionRoutes } = await import('./routes/extensions.js');
  app.route('/api/extensions', extensionRoutes);

  const { providerRoutes } = await import('./routes/providers.js');
  app.route('/api/providers', providerRoutes);

  // tRPC procedures for server-answered groups (openspec adopt-trpc-browser-api).
  // Before the proxy catch-all: `/api/trpc` is never forwarded to a runner.
  const { mountTrpc } = await import('./trpc/mount.js');
  mountTrpc(app);

  // Setup status — proxy to runner
  // NOTE: `/api/setup/status` is intentionally NOT handled here. Claude CLI
  // availability is a per-user-runner property, so this request falls through to
  // the proxy catch-all below and is answered by the requesting user's runner
  // (real detection in packages/runtime). A previous stub returned
  // `claudeCli.available: true` unconditionally, which was misleading — the
  // server never has a Claude CLI of its own.

  // ── Proxy catch-all: forward remaining API requests to runner ──
  const { proxyToRunner } = await import('./middleware/proxy.js');

  // Thread-scoped git ops (`/api/git/:threadId/<action>`) must stay OWNER-ONLY.
  // They have no explicit server route otherwise — they would fall through to the
  // catch-all proxy, which resolves the *requesting user's* runner. For a sharee
  // (a project member with their own checkout) that silently routes the git op to
  // the wrong working copy. The explicit owner gate makes a non-owner cleanly 404
  // before any proxy. Project-scoped git ops (`/api/git/project/<projectId>/…` and
  // the `/api/git/status?projectId=` form) are NOT thread-scoped, so they pass
  // through to the proxy and rely on the existing user-scoped runner resolution —
  // they MUST be registered first so `:id` does not capture the literal `project`
  // segment or the bare `status` path. (See thread-sharing design.)
  app.all('/api/git/project/*', proxyToRunner);
  app.all('/api/git/status', proxyToRunner);

  // READ-ONLY thread-scoped git is ALLOW-LISTED for steer sharees
  // (thread-sharing-steer): owner OR a `steer` sharee may GET status / diff / log
  // / commit details. These run on the OWNER's runner (steer resolution crosses
  // isolation), so they are deliberately limited to GET on these exact read
  // sub-paths and registered BEFORE the owner-only catch-all. Every other git op
  // (stage, commit, stash, push, PR, convert) stays owner-only below — a sharee
  // never uses the owner's GitHub token. The runtime re-checks the same grant.
  app.get('/api/git/:id/status', requireThreadSteer, proxyToRunner);
  app.get('/api/git/:id/diff', requireThreadSteer, proxyToRunner);
  app.get('/api/git/:id/diff/*', requireThreadSteer, proxyToRunner);
  app.get('/api/git/:id/log', requireThreadSteer, proxyToRunner);
  app.get('/api/git/:id/graph-log', requireThreadSteer, proxyToRunner);
  app.get('/api/git/:id/reflog-events', requireThreadSteer, proxyToRunner);
  app.get('/api/git/:id/commit/*', requireThreadSteer, proxyToRunner);

  // Everything else thread-scoped under /api/git stays OWNER-ONLY.
  app.all('/api/git/:id/*', requireThreadOwner, proxyToRunner);

  app.all('/api/*', proxyToRunner);

  await opts.mountAssets?.(app);
  return app;
}
