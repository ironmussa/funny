/**
 * Server entry point.
 *
 * The server initializes its own DB, auth, and data routes.
 * Filesystem/git/agent operations are proxied to remote runners
 * connected via WebSocket tunnel.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

import { VISUALIZER_IMPORT_MAP_JSON } from '@funny/shared/visualizer-importmap';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { csrf } from 'hono/csrf';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';

import { log } from './lib/logger.js';
import type { ServerEnv } from './lib/types.js';
import { authMiddleware, setAuthInstance } from './middleware/auth.js';

// ── Init ────────────────────────────────────────────────

// Auth instance — populated during init, used by middleware and route handlers.
// Uses `any` because the runtime and server auth instances have slightly different types
// (different access control statements, different plugin configurations).
let authInstance: any;

// CSP source expression for the inline visualizer import map (see secureHeaders
// below). Computed from the exact bytes the client injects, so the policy always
// matches the page.
const VISUALIZER_IMPORT_MAP_CSP_HASH = `'sha256-${createHash('sha256')
  .update(VISUALIZER_IMPORT_MAP_JSON, 'utf8')
  .digest('base64')}'`;

// Ensure a RUNNER_AUTH_SECRET exists
if (!process.env.RUNNER_AUTH_SECRET) {
  log.error('RUNNER_AUTH_SECRET is required. Set it in your .env file.', {
    namespace: 'server',
  });
  process.exit(1);
}

// Security CR-1: the three shared secrets cross independent trust boundaries
// (runner↔server, orchestrator↔server, external webhook→runner). Reusing one
// value across them means compromise of any single path leaks all three.
// Refuse to boot when any two are set to the same value.
{
  const { findDuplicateSecretPairs, findWeakSecrets, MIN_SECRET_LENGTH } =
    await import('./lib/secret-check.js');
  const presentSecrets = {
    RUNNER_AUTH_SECRET: process.env.RUNNER_AUTH_SECRET,
    INGEST_WEBHOOK_SECRET: process.env.INGEST_WEBHOOK_SECRET,
    ORCHESTRATOR_AUTH_SECRET: process.env.ORCHESTRATOR_AUTH_SECRET,
  };
  const duplicates = findDuplicateSecretPairs(presentSecrets);
  if (duplicates.length > 0) {
    log.error(
      'Shared secrets must be distinct. Generate a fresh value for each with `openssl rand -hex 32`.',
      {
        namespace: 'server',
        duplicates: duplicates.map(([a, b]) => `${a} === ${b}`),
      },
    );
    process.exit(1);
  }

  // Security: RUNNER_AUTH_SECRET is the HMAC key for forwarded-identity
  // signing — a weak value lets a caller forge any user's identity against a
  // runner. Refuse to boot on a too-short shared secret.
  const weak = findWeakSecrets(presentSecrets);
  if (weak.length > 0) {
    log.error(
      `Shared secrets must be at least ${MIN_SECRET_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`,
      { namespace: 'server', weak },
    );
    process.exit(1);
  }
}

// ── Always initialize server DB and auth ────────────────
const { initDatabase } = await import('./db/index.js');
const { autoMigrate } = await import('./db/migrate.js');
const { initBetterAuth, auth } = await import('./lib/auth.js');

const dbResult = await initDatabase();
if (dbResult.isErr()) {
  log.error(dbResult.error, { namespace: 'db' });
  process.exit(1);
}
await autoMigrate();
await initBetterAuth();
authInstance = auth;
setAuthInstance(authInstance);

const { dbDialect } = await import('./db/index.js');
log.info(`Server initialized — DB mode: ${dbDialect}`, { namespace: 'server' });

// On restart, purge all runners and their project assignments.
// No runner has an active WebSocket connection at this point, so all
// state is stale. Runners will re-register and re-assign projects on connect.
const { purgeAllRunners, purgeStaleRunners } = await import('./services/runner-manager.js');
await purgeAllRunners();
await purgeStaleRunners();

// ── App ─────────────────────────────────────────────────

const app = new Hono<ServerEnv>();

// Middleware
const devClientPort = process.env.VITE_PORT || '5173';
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
  : [`http://localhost:${devClientPort}`, `http://127.0.0.1:${devClientPort}`];

app.use('*', cors({ origin: corsOrigins, credentials: true }));
// Security HI-7: defense-in-depth on top of `SameSite=Strict` session cookies.
// `csrf()` blocks form-submittable POSTs (form-urlencoded / multipart /
// text/plain — the CORS-"simple" content types that browsers send cross-
// origin WITHOUT preflight) unless the Origin matches the allowlist. JSON
// requests are unaffected because they require CORS preflight and so are
// already gated by the same allowlist via the `cors()` middleware above.
// Runner/orchestrator/proxy traffic is JSON-only, so this is invisible to
// them.
app.use('*', csrf({ origin: corsOrigins }));
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
      scriptSrc: ["'self'", VISUALIZER_IMPORT_MAP_CSP_HASH],
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
      imgSrc: ["'self'", 'data:', 'blob:'],
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
// Security HI-10: CSP/COOP override for the MCP OAuth callback page and its
// same-origin script. The runtime now serves the page WITHOUT an inline
// script — the HTML loads `/api/mcp/oauth/callback.js` instead — so we can
// drop `script-src 'unsafe-inline'` and restore origin isolation via
// `Cross-Origin-Opener-Policy: same-origin-allow-popups` (still preserves
// `window.opener` for the parent that launched the popup, but isolates us
// from the cross-origin OAuth provider's intermediate page).
//
// Match the runtime's override exactly so a response that lands here
// (server is in front of the runner via tunnel/proxy) is not silently
// loosened on its way back to the browser.
app.use('/api/mcp/oauth/callback*', async (c, next) => {
  await next();
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  );
});

app.use('*', logger());

// Health check (before auth)
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
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

// Better Auth routes — use app.all to handle all HTTP methods (GET, POST, DELETE, etc.)
app.all('/api/auth/*', (c) => authInstance.handler(c.req.raw));

// Auth middleware for all API routes
app.use('/api/*', authMiddleware);

// Per-user rate limit on authenticated API endpoints (runs after auth so the
// limiter can key off userId; otherwise every request looks anonymous).
app.use('/api/*', rateLimit({ windowMs: 60_000, max: 1200, perUser: true }));

// ── Server-managed data routes ───────────────────────────
const { authRoutes } = await import('./routes/auth.js');
const { projectRoutes } = await import('./routes/projects.js');
const { runnerRoutes } = await import('./routes/runners.js');
const { profileRoutes } = await import('./routes/profile.js');
const { threadRoutes, requireThreadOwner } = await import('./routes/threads.js');
const { automationRoutes } = await import('./routes/automations.js');
const { settingsRoutes } = await import('./routes/settings.js');
const { teamProjectRoutes } = await import('./routes/team-projects.js');
const { teamSettingsRoutes } = await import('./routes/team-settings.js');
const { analyticsRoutes } = await import('./routes/analytics.js');
const { pipelineRoutes } = await import('./routes/pipelines.js');
const { designRoutes, designProjectRoutes } = await import('./routes/designs.js');
const { agentTemplateRoutes } = await import('./routes/agent-templates.js');
const { orchestratorRoutes } = await import('./routes/orchestrator.js');
const { orchestratorSystemRoutes } = await import('./routes/orchestrator-system.js');
const { watcherRoutes } = await import('./routes/watchers.js');
const { jobRoutes } = await import('./routes/jobs.js');
const { userRoutes } = await import('./routes/users.js');

app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/users', userRoutes);
app.route('/api/runners', runnerRoutes);
app.route('/api/profile', profileRoutes);
app.route('/api/threads', threadRoutes);
app.route('/api/automations', automationRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/team-projects', teamProjectRoutes);
app.route('/api/team-settings', teamSettingsRoutes);
app.route('/api/analytics', analyticsRoutes);
app.route('/api/pipelines', pipelineRoutes);
app.route('/api/invite-links', inviteLinkRoutes);
app.route('/api/designs', designRoutes);
app.route('/api/projects', designProjectRoutes);
app.route('/api/agent-templates', agentTemplateRoutes);
app.route('/api/watchers', watcherRoutes);
app.route('/api/jobs', jobRoutes);
// System routes mounted FIRST so /api/orchestrator/system/* matches them
// before the user-scoped /api/orchestrator/* tree.
app.route('/api/orchestrator/system', orchestratorSystemRoutes);
app.route('/api/orchestrator', orchestratorRoutes);

const { extensionRoutes } = await import('./routes/extensions.js');
app.route('/api/extensions', extensionRoutes);

const { providerRoutes } = await import('./routes/providers.js');
app.route('/api/providers', providerRoutes);

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
app.all('/api/git/:id/*', requireThreadOwner, proxyToRunner);

app.all('/api/*', proxyToRunner);

// ── Installed client extensions (visualizer plugins) ──────
// Serve pre-built ESM assets from <DATA_DIR>/extensions/<name>/. Registered
// before the static client + SPA catch-all so these paths are not shadowed.
// Not under /api, so unauthenticated like the rest of the client bundle; the
// browser dynamically imports these as same-origin modules (script-src 'self').
// Path traversal + symlink escape are blocked by `resolveExtensionAsset`.
const { resolveExtensionAsset, extensionAssetContentType } = await import('./lib/extensions.js');
app.get('/extensions/:name/*', async (c) => {
  const name = c.req.param('name');
  const prefix = `/extensions/${name}/`;
  const rest = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
  let relPath: string;
  try {
    relPath = decodeURIComponent(rest);
  } catch {
    return c.notFound();
  }
  const file = resolveExtensionAsset(decodeURIComponent(name), relPath);
  if (!file) return c.notFound();
  c.header('Content-Type', extensionAssetContentType(file));
  // Extension entry URLs are NOT content-hashed (e.g. dist/index.mjs), so they
  // must revalidate — otherwise reinstalling/updating an extension keeps serving
  // a stale bundle from the browser cache. `no-store` keeps it always fresh.
  // (A future optimization could content-hash the URL and cache immutably.)
  c.header('Cache-Control', 'no-store');
  return c.body(await Bun.file(file).arrayBuffer());
});

// Serve static files from client build (only if dist exists)
// Security L3: static responses inherit X-Content-Type-Options: nosniff from
// the global `secureHeaders()` middleware registered above — do not disable
// its `xContentTypeOptions` default, or browsers will MIME-sniff bundled
// assets and could execute attacker-controlled content under the server origin.
const clientDistDir = resolve(import.meta.dir, '..', '..', 'client', 'dist');

if (existsSync(clientDistDir)) {
  app.use('/*', serveStatic({ root: clientDistDir }));
  app.get('*', async (c) => {
    return c.html(await Bun.file(join(clientDistDir, 'index.html')).text());
  });
  log.info('Serving static files', { namespace: 'server', dir: clientDistDir });
}

// ── Server ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3001', 10);
// Security CR-7: default to loopback. The auto-generated admin credentials
// (`~/.funny/admin-password.txt`) are written *after* the server starts
// listening; binding all interfaces by default opens a window where the
// stock admin/admin race is reachable from the LAN/internet. Operators who
// genuinely want remote exposure set HOST=0.0.0.0 explicitly.
const { resolveHost } = await import('./lib/host-default.js');
const HOST = resolveHost(process.env.HOST);

// Initialize Socket.IO server with Bun-native engine
const { createSocketIOServer, closeSocketIO } = await import('./services/socketio.js');
const { engine: socketEngine } = createSocketIOServer(authInstance, corsOrigins);

// Orchestrator runs as a separate process (`@funny/thread-orchestrator` binary)
// that talks to the server via /api/orchestrator/system/*. The server no
// longer hosts the brain in-process — see README "Running the orchestrator
// standalone" for the migration path.

const server = Bun.serve({
  // Spread Bun engine handler FIRST — provides the `websocket` property
  // for native Bun WebSocket lifecycle (open/message/close).
  ...socketEngine.handler(),
  port: PORT,
  hostname: HOST,
  reusePort: true,
  async fetch(req, server) {
    // Handle Socket.IO requests BEFORE Hono — WebSocket upgrades need
    // direct access to Bun's server.upgrade(), which returns undefined
    // (Hono always expects a Response, so it can't handle upgrades).
    const url = new URL(req.url);
    if (url.pathname.startsWith('/socket.io/')) {
      return socketEngine.handleRequest(req, server);
    }
    return app.fetch(req, { IP: server.requestIP(req) });
  },
});

log.info(`funny-server running on http://${HOST}:${PORT}`, {
  namespace: 'server',
});

// ── Runner status monitor (debug) ────────────────────────
// Socket.IO handles heartbeats natively (pingInterval/pingTimeout),
// so we only check periodically for DB↔connection state mismatches.
const RUNNER_STATUS_INTERVAL_MS = 30_000;
let runnerStatusTimer: ReturnType<typeof setInterval> | null = null;
let lastRunnerStateHash = '';

if (process.env.NODE_ENV !== 'production') {
  runnerStatusTimer = setInterval(async () => {
    try {
      const wsRelay = await import('./services/ws-relay.js');
      const rm = await import('./services/runner-manager.js');
      const stats = wsRelay.getRelayStats();
      const allRunners = await rm.listRunners();

      if (allRunners.length === 0 && stats.runners === 0) return; // nothing to report

      const runnerDetails = allRunners.map((r) => ({
        id: r.runnerId.slice(0, 8),
        name: r.name,
        dbStatus: r.status,
        connected: wsRelay.isRunnerConnected(r.runnerId),
        lastHb: r.lastHeartbeatAt,
        threads: r.activeThreadCount,
        projects: r.assignedProjectIds.length,
      }));

      // Warn when there's a mismatch between Socket.IO connection and DB status
      const hasIssue = runnerDetails.some(
        (r) =>
          (r.dbStatus === 'online' && !r.connected) || (r.dbStatus === 'offline' && r.connected),
      );

      // Only log when state changes or there's an issue
      const stateHash = JSON.stringify(
        runnerDetails.map((r) => `${r.id}:${r.dbStatus}:${r.connected}`),
      );
      if (stateHash === lastRunnerStateHash && !hasIssue) return;
      lastRunnerStateHash = stateHash;

      const level = hasIssue ? 'warn' : 'info';
      log[level]('Runner status', {
        namespace: 'runner-monitor',
        runners: stats.runners,
        browsers: stats.browserClients,
        runnerDetails: JSON.stringify(runnerDetails),
      });
    } catch {
      // Ignore — DB may not be ready yet
    }
  }, RUNNER_STATUS_INTERVAL_MS);
}

// ── Graceful shutdown ────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down…', { namespace: 'server' });

  // Stop runner status monitor
  if (runnerStatusTimer) clearInterval(runnerStatusTimer);

  // Force exit after 5 seconds if graceful shutdown hangs
  const forceExit = setTimeout(() => {
    log.warn('Force exit after timeout', { namespace: 'server' });
    process.exit(1);
  }, 5000);

  // Close Socket.IO connections
  await closeSocketIO();

  // Stop accepting new connections (don't wait for in-flight)
  server.stop();

  // Close the server DB connection
  try {
    const { closeDatabase } = await import('./db/index.js');
    await closeDatabase();
  } catch {
    // Already closed or not initialized
  }

  clearTimeout(forceExit);
  log.info('Shutdown complete', { namespace: 'server' });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

// Catch unhandled errors — keep server alive
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception — keeping server alive', {
    namespace: 'server',
    error: err?.message ?? String(err),
    stack: err?.stack,
  });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error('Unhandled rejection — keeping server alive', {
    namespace: 'server',
    error: msg,
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

export { app, server };
