/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: McpService
 */

import { badRequest } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err } from 'neverthrow';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { startOAuthFlow, handleOAuthCallback } from '../services/mcp-oauth.js';

/** Header carrying the server-minted, server-signed OAuth state. */
const OAUTH_STATE_HEADER = 'X-Funny-OAuth-State';
const BOUND_STATE_PATTERN = /^[A-Za-z0-9._-]{16,1024}$/;

function readBoundState(value: string | undefined): string | null {
  return value && BOUND_STATE_PATTERN.test(value) ? value : null;
}
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  toggleMcpServer,
  RECOMMENDED_SERVERS,
} from '../services/mcp-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resolveClaudeProfileRouteOptions } from '../utils/agent-profile-options.js';
import { requireProjectPath } from '../utils/path-scope.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseJsonBody } from '../validation/request.js';
import { addMcpServerSchema, agentProviderSchema, validate } from '../validation/schemas.js';

const app = new Hono<HonoEnv>();

const toggleMcpServerSchema = z.object({
  projectPath: z.string().min(1, 'projectPath is required'),
  projectId: z.string().min(1).optional(),
  provider: agentProviderSchema.default('claude'),
  disabled: z.boolean(),
});

const mcpOAuthStartSchema = z.object({
  serverName: z.string().min(1, 'serverName is required'),
  projectPath: z.string().min(1, 'projectPath is required'),
  projectId: z.string().min(1).optional(),
  provider: agentProviderSchema.default('claude'),
});

const mcpOAuthTokenSchema = mcpOAuthStartSchema.extend({
  token: z.string().min(1, 'token is required'),
});

// List MCP servers for a project
app.get('/servers', async (c) => {
  const projectPath = c.req.query('projectPath');
  const provider = c.req.query('provider') ?? 'claude';
  const projectId = c.req.query('projectId') || undefined;
  if (!projectPath)
    return resultToResponse(c, err(badRequest('projectPath query parameter required')));

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const profileOptions = await resolveClaudeProfileRouteOptions({
    provider,
    projectId,
    userId: c.get('userId'),
  });
  const result = await listMcpServers(projectPath, provider, profileOptions);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ servers: result.value });
});

// Add an MCP server
app.post('/servers', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(addMcpServerSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const denied = await requireProjectPath(parsed.value.projectPath, c.get('userId'));
  if (denied) return denied;

  const provider = parsed.value.provider ?? 'claude';
  const profileOptions = await resolveClaudeProfileRouteOptions({
    provider,
    projectId: parsed.value.projectId,
    userId: c.get('userId'),
  });
  const result = await addMcpServer({ ...parsed.value, provider, ...profileOptions });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Remove an MCP server
app.delete('/servers/:name', async (c) => {
  const name = c.req.param('name');
  const projectPath = c.req.query('projectPath');
  const provider = c.req.query('provider') ?? 'claude';
  const projectId = c.req.query('projectId') || undefined;
  const scope = c.req.query('scope') as 'project' | 'user' | undefined;

  if (!projectPath)
    return resultToResponse(c, err(badRequest('projectPath query parameter required')));

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const profileOptions = await resolveClaudeProfileRouteOptions({
    provider,
    projectId,
    userId: c.get('userId'),
  });
  const result = await removeMcpServer({ name, projectPath, provider, scope, ...profileOptions });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Toggle MCP server enabled/disabled
app.patch('/servers/:name/toggle', async (c) => {
  const name = c.req.param('name');
  const parsed = await parseJsonBody(c, toggleMcpServerSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectPath, projectId, provider, disabled } = parsed.value;

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const profileOptions = await resolveClaudeProfileRouteOptions({
    provider,
    projectId,
    userId: c.get('userId'),
  });
  const result = await toggleMcpServer({
    name,
    projectPath,
    provider,
    disabled,
    ...profileOptions,
  });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// Get recommended MCP servers
app.get('/recommended', (c) => {
  return c.json({ servers: RECOMMENDED_SERVERS });
});

/**
 * Reconstruct the public-facing origin from forwarded headers. When requests
 * arrive via the gRPC tunnel, c.req.url is http://localhost (no port).
 */
function publicCallbackBaseUrl(c: Context<HonoEnv>, serverName: string): string {
  const fwdHost = c.req.header('X-Forwarded-Host');
  const fwdProto = c.req.header('X-Forwarded-Proto');
  const reqUrl = new URL(c.req.url);
  const callbackBaseUrl = fwdHost
    ? `${fwdProto || 'http'}://${fwdHost}`
    : `${reqUrl.protocol}//${reqUrl.host}`;
  log.info('OAuth start: reconstructed callback base URL', {
    namespace: 'mcp',
    serverName,
    fwdHost: fwdHost ?? null,
    fwdProto: fwdProto ?? null,
    reqUrl: c.req.url,
    callbackBaseUrl,
    usedForwardedHost: Boolean(fwdHost),
  });
  return callbackBaseUrl;
}

// Start OAuth flow for an MCP server
app.post('/oauth/start', async (c) => {
  const parsed = await parseJsonBody(c, mcpOAuthStartSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { serverName, projectPath, projectId, provider } = parsed.value;

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const profileOptions = await resolveClaudeProfileRouteOptions({
    provider,
    projectId,
    userId: c.get('userId'),
  });
  const serversResult = await listMcpServers(projectPath, provider, profileOptions);
  if (serversResult.isErr()) return resultToResponse(c, serversResult);
  const servers = serversResult.value;

  const server = servers.find((s) => s.name === serverName);
  if (!server) return resultToResponse(c, err(badRequest(`Server "${serverName}" not found`)));
  if (!server.url)
    return resultToResponse(
      c,
      err(badRequest(`Server "${serverName}" has no URL (only HTTP servers support OAuth)`)),
    );

  const callbackBaseUrl = publicCallbackBaseUrl(c, serverName);

  // The server binds the flow to this runner + user by minting the OAuth
  // `state` itself (H3/M3): the unauthenticated callback is then routed back
  // here only. Without it the callback cannot be routed, so refuse up front.
  const boundState = readBoundState(c.req.header(OAUTH_STATE_HEADER));
  if (!boundState) {
    return resultToResponse(
      c,
      err(badRequest('OAuth state binding missing — update the funny server to this version')),
    );
  }

  const oauthResult = await startOAuthFlow(serverName, server.url, projectPath, callbackBaseUrl, {
    ...profileOptions,
    state: boundState,
  });
  if (oauthResult.isErr()) return resultToResponse(c, oauthResult);
  return c.json({ authUrl: oauthResult.value.authUrl });
});

// Set a manual bearer token for an MCP server
app.post('/oauth/token', async (c) => {
  const parsed = await parseJsonBody(c, mcpOAuthTokenSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { serverName, projectPath, projectId, provider, token } = parsed.value;

  const denied = await requireProjectPath(projectPath, c.get('userId'));
  if (denied) return denied;

  const profileOptions = await resolveClaudeProfileRouteOptions({
    provider,
    projectId,
    userId: c.get('userId'),
  });
  const serversResult = await listMcpServers(projectPath, provider, profileOptions);
  if (serversResult.isErr()) return resultToResponse(c, serversResult);
  const servers = serversResult.value;

  const server = servers.find((s) => s.name === serverName);
  if (!server) return resultToResponse(c, err(badRequest(`Server "${serverName}" not found`)));
  if (!server.url) return resultToResponse(c, err(badRequest(`Server "${serverName}" has no URL`)));

  // Remove and re-add with Authorization header (best-effort remove)
  await removeMcpServer({ name: serverName, projectPath, provider, ...profileOptions });

  const addResult = await addMcpServer({
    name: serverName,
    provider,
    type: 'http',
    url: server.url,
    headers: { Authorization: `Bearer ${token}` },
    projectPath,
    ...profileOptions,
  });
  if (addResult.isErr()) return resultToResponse(c, addResult);

  return c.json({ ok: true });
});

// OAuth callback (external OAuth provider redirect — exempt from bearer auth).
// The server routes it here by its signed `state` and renders the page itself
// (H3): this route only answers JSON, never HTML or script, so nothing a
// runner returns is ever executed on the server's origin.
app.get('/oauth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error) {
    return c.json({ success: false, error: c.req.query('error_description') || error });
  }
  if (!code || !state) {
    return c.json({ success: false, error: 'Missing code or state parameter' }, 400);
  }

  const result = await handleOAuthCallback(code, state);
  return c.json({ success: result.success, error: result.error ?? null });
});

export default app;
