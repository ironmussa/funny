/**
 * GitHub webhook HTTP route — thin wrapper that validates signatures
 * and delegates to GitHubWebhookAdapter for event translation.
 */

import { Hono } from 'hono';

import { GitHubWebhookAdapter } from '../adapters/inbound/github-webhook.adapter.js';
import type { PipelineServiceConfig } from '../config/schema.js';
import type { EventBus } from '../infrastructure/event-bus.js';

// ── HMAC signature validation ────────────────────────────────────

async function verifySignature(
  secret: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
  return signature === expected;
}

// ── Route factory ────────────────────────────────────────────────

export function createWebhookRoutes(
  eventBus: EventBus,
  config: PipelineServiceConfig,
  projectPath?: string,
): Hono {
  const app = new Hono();
  const adapter = new GitHubWebhookAdapter(eventBus, projectPath);

  app.post('/github', async (c) => {
    const rawBody = await c.req.text();

    // Validate signature if secret is configured
    if (config.webhook_secret) {
      const signature = c.req.header('X-Hub-Signature-256') ?? '';
      if (!signature) {
        return c.json({ error: 'Missing X-Hub-Signature-256 header' }, 401);
      }
      const valid = await verifySignature(config.webhook_secret, rawBody, signature);
      if (!valid) {
        return c.json({ error: 'Invalid signature' }, 401);
      }
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const githubEvent = c.req.header('X-GitHub-Event') ?? '';
    const result = await adapter.handle(githubEvent, payload);

    return c.json(result, 200);
  });

  return app;
}
