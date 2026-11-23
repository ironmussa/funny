import { Hono } from 'hono';

import { getServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { validate, githubPollSchema } from '../../validation/schemas.js';
import {
  ACCESS_TOKEN_URL,
  DEVICE_CODE_URL,
  getClientId,
  githubApiFetch,
  resolveGithubToken,
} from './helpers.js';

export const authRoutes = new Hono<HonoEnv>();

// ── GET /status — check GitHub connection ──────────────────

authRoutes.get('/status', async (c) => {
  const userId = c.get('userId');

  const resolved = await resolveGithubToken(userId);
  if (!resolved) {
    return c.json({ connected: false });
  }

  // Token found — try to fetch login for display, but always report connected.
  try {
    const res = await githubApiFetch('/user', resolved.token);
    if (res.ok) {
      const user = (await res.json()) as { login: string };
      return c.json({ connected: true, login: user.login, source: resolved.source });
    }
  } catch {
    // Ignore — we still know a token exists
  }

  return c.json({ connected: true, source: resolved.source });
});

// ── POST /oauth/device — start Device Flow ─────────────────

authRoutes.post('/oauth/device', async (c) => {
  const clientId = getClientId();
  if (!clientId) {
    return c.json({ error: 'GITHUB_CLIENT_ID is not configured on the server' }, 500);
  }

  try {
    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'repo',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return c.json({ error: `GitHub device code request failed: ${body}` }, 502);
    }

    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return c.json({
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /oauth/poll — poll for Device Flow token ──────────

authRoutes.post('/oauth/poll', async (c) => {
  const clientId = getClientId();
  if (!clientId) {
    return c.json({ error: 'GITHUB_CLIENT_ID is not configured' }, 500);
  }

  const userId = c.get('userId');
  const raw = await c.req.json();
  const parsed = validate(githubPollSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { deviceCode } = parsed.value;

  try {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    };

    if (data.error) {
      if (data.error === 'authorization_pending') {
        return c.json({ status: 'pending' });
      }
      if (data.error === 'slow_down') {
        return c.json({ status: 'pending', interval: data.interval });
      }
      if (data.error === 'expired_token') {
        return c.json({ status: 'expired' });
      }
      if (data.error === 'access_denied') {
        return c.json({ status: 'denied' });
      }
      return c.json({ error: data.error_description || data.error }, 400);
    }

    if (data.access_token) {
      // Store the token encrypted in the user's profile
      await getServices().profile.updateProfile(userId, { githubToken: data.access_token });
      return c.json({ status: 'success', scopes: data.scope });
    }

    return c.json({ status: 'pending' });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── DELETE /oauth/disconnect — clear GitHub token ──────────

authRoutes.delete('/oauth/disconnect', async (c) => {
  const userId = c.get('userId');
  await getServices().profile.updateProfile(userId, { githubToken: null });
  return c.json({ ok: true });
});

// ── GET /user — get authenticated GitHub user ──────────────

authRoutes.get('/user', async (c) => {
  const userId = c.get('userId');
  const resolved = await resolveGithubToken(userId);
  if (!resolved) {
    return c.json({ error: 'Not connected to GitHub' }, 401);
  }

  const res = await githubApiFetch('/user', resolved.token);
  if (!res.ok) {
    return c.json({ error: 'Failed to fetch GitHub user' }, 502);
  }

  const user = (await res.json()) as { login: string; avatar_url: string; name: string | null };
  return c.json({ login: user.login, avatar_url: user.avatar_url, name: user.name });
});
