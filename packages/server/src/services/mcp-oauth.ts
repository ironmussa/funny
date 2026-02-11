/**
 * MCP OAuth 2.1 Service
 *
 * Handles OAuth discovery, PKCE, authorization, and token exchange
 * for HTTP MCP servers that require authentication.
 */

import { randomBytes, createHash } from 'crypto';
import { db, schema } from '../db/index.js';
import { eq, and } from 'drizzle-orm';
import { addMcpServer, removeMcpServer } from './mcp-service.js';

// ── Types ─────────────────────────────────────────────────────

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
}

interface OAuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

interface DynamicClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface OAuthPendingState {
  serverName: string;
  projectPath: string;
  serverUrl: string;
  codeVerifier: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
}

// ── In-memory state store with TTL ────────────────────────────

const pendingStates = new Map<string, OAuthPendingState>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of pendingStates) {
    if (now - state.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}, 60_000);

// ── PKCE utilities ────────────────────────────────────────────

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url').slice(0, 128);
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

// ── OAuth Discovery ───────────────────────────────────────────

async function discoverResourceMetadata(serverUrl: string): Promise<string> {
  // Hit the MCP server to get a 401 with WWW-Authenticate header
  const res = await fetch(serverUrl, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });

  if (res.status === 401) {
    const wwwAuth = res.headers.get('www-authenticate') || '';
    const match = wwwAuth.match(/resource_metadata="([^"]+)"/);
    if (match) return match[1];
  }

  // Fallback: try .well-known/oauth-protected-resource
  const url = new URL(serverUrl);
  const wellKnownUrl = `${url.origin}/.well-known/oauth-protected-resource`;
  const fallbackRes = await fetch(wellKnownUrl);
  if (fallbackRes.ok) {
    const meta = (await fallbackRes.json()) as ProtectedResourceMetadata;
    if (meta.authorization_servers?.[0]) return meta.authorization_servers[0];
  }

  throw new Error(`Could not discover OAuth metadata from ${serverUrl}`);
}

async function fetchAuthServerMetadata(authServerUrl: string): Promise<OAuthServerMetadata> {
  const url = new URL(authServerUrl);

  // Try .well-known/oauth-authorization-server
  const oauthUrl = `${url.origin}/.well-known/oauth-authorization-server${url.pathname === '/' ? '' : url.pathname}`;
  let res = await fetch(oauthUrl);

  if (!res.ok) {
    // Fallback to OpenID Connect discovery
    const oidcUrl = `${url.origin}/.well-known/openid-configuration`;
    res = await fetch(oidcUrl);
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch auth server metadata from ${authServerUrl}`);
  }

  return res.json() as Promise<OAuthServerMetadata>;
}

async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  serverName: string,
): Promise<DynamicClientRegistration> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `a-parallel (${serverName})`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dynamic client registration failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<DynamicClientRegistration>;
}

// ── Main OAuth flow ───────────────────────────────────────────

export async function startOAuthFlow(
  serverName: string,
  serverUrl: string,
  projectPath: string,
  callbackBaseUrl: string,
): Promise<{ authUrl: string; state: string }> {
  const redirectUri = `${callbackBaseUrl}/api/mcp/oauth/callback`;

  // Step 1: Discover resource metadata URL
  let resourceMetadataUrl: string;
  try {
    resourceMetadataUrl = await discoverResourceMetadata(serverUrl);
  } catch {
    resourceMetadataUrl = serverUrl;
  }

  // Step 2: Get protected resource metadata → auth server URL
  let authServerUrl: string;
  try {
    const resourceMeta = await fetch(resourceMetadataUrl);
    if (resourceMeta.ok) {
      const meta = (await resourceMeta.json()) as ProtectedResourceMetadata;
      authServerUrl = meta.authorization_servers?.[0] || new URL(serverUrl).origin;
    } else {
      authServerUrl = new URL(serverUrl).origin;
    }
  } catch {
    authServerUrl = new URL(serverUrl).origin;
  }

  // Step 3: Get auth server metadata
  const authMeta = await fetchAuthServerMetadata(authServerUrl);

  // Step 4: Dynamic client registration
  let clientId: string;
  let clientSecret: string | undefined;

  if (authMeta.registration_endpoint) {
    const client = await registerClient(authMeta.registration_endpoint, redirectUri, serverName);
    clientId = client.client_id;
    clientSecret = client.client_secret;
  } else {
    throw new Error(
      'This MCP server does not support dynamic client registration. ' +
        'You may need to authenticate via the Claude Code terminal (/mcp) instead.',
    );
  }

  // Step 5: Generate PKCE and state
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingStates.set(state, {
    serverName,
    projectPath,
    serverUrl,
    codeVerifier,
    tokenEndpoint: authMeta.token_endpoint,
    clientId,
    clientSecret,
    redirectUri,
    createdAt: Date.now(),
  });

  // Build authorization URL
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  if (authMeta.scopes_supported?.length) {
    authParams.set('scope', authMeta.scopes_supported.join(' '));
  }

  const authUrl = `${authMeta.authorization_endpoint}?${authParams.toString()}`;
  return { authUrl, state };
}

export async function handleOAuthCallback(
  code: string,
  state: string,
): Promise<{ serverName: string; success: boolean; error?: string }> {
  const pending = pendingStates.get(state);
  if (!pending) {
    return { serverName: 'unknown', success: false, error: 'Invalid or expired state parameter' };
  }

  pendingStates.delete(state);

  if (Date.now() - pending.createdAt > STATE_TTL_MS) {
    return { serverName: pending.serverName, success: false, error: 'OAuth state expired' };
  }

  try {
    // Exchange authorization code for tokens
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.codeVerifier,
    });

    if (pending.clientSecret) {
      tokenBody.set('client_secret', pending.clientSecret);
    }

    const tokenRes = await fetch(pending.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      throw new Error(`Token exchange failed: ${tokenRes.status} ${errBody}`);
    }

    const tokens = (await tokenRes.json()) as TokenResponse;

    // Store tokens in database
    const now = new Date().toISOString();
    const id = randomBytes(8).toString('hex');
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;

    // Upsert: delete existing, then insert
    db.delete(schema.mcpOauthTokens)
      .where(
        and(
          eq(schema.mcpOauthTokens.serverName, pending.serverName),
          eq(schema.mcpOauthTokens.projectPath, pending.projectPath),
        ),
      )
      .run();

    db.insert(schema.mcpOauthTokens)
      .values({
        id,
        serverName: pending.serverName,
        projectPath: pending.projectPath,
        serverUrl: pending.serverUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenType: tokens.token_type || 'Bearer',
        expiresAt: expiresAt || null,
        scope: tokens.scope || null,
        tokenEndpoint: pending.tokenEndpoint,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret || null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Update Claude CLI config: remove and re-add with Authorization header
    try {
      await removeMcpServer({ name: pending.serverName, projectPath: pending.projectPath });
    } catch {
      // May not exist, that's fine
    }

    await addMcpServer({
      name: pending.serverName,
      type: 'http',
      url: pending.serverUrl,
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      projectPath: pending.projectPath,
    });

    return { serverName: pending.serverName, success: true };
  } catch (err: any) {
    console.error('[mcp-oauth] Token exchange failed:', err);
    return { serverName: pending.serverName, success: false, error: err.message };
  }
}
