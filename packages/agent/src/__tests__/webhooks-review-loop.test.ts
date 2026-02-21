/**
 * E2E test: GitHub webhook → PR Review Loop
 *
 * Tests the full flow from receiving a GitHub pull_request_review webhook
 * to triggering the pr-review-loop workflow and emitting events.
 *
 * Flow tested:
 *   1. POST /webhooks/github with pull_request_review payload
 *   2. Webhook handler validates, routes by event type
 *   3. `changes_requested` → publishes review_loop.started + triggers Hatchet workflow
 *   4. `approved` → publishes review_loop.completed + emits pr.approved to Hatchet
 *   5. Non-integration branches are ignored
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import type { PipelineEvent } from '../core/types.js';

// ── Mock Hatchet SDK before anything imports it ─────────────────

const mockEventPush = mock(() => Promise.resolve());
const mockRunNoWait = mock(() => Promise.resolve({ runId: 'mock-run-1' }));

mock.module('@hatchet-dev/typescript-sdk/v1', () => ({
  HatchetClient: {
    init: () => ({
      event: { push: mockEventPush },
      runNoWait: mockRunNoWait,
    }),
  },
}));

// Mock the hatchet/client module to return our mocked functions
mock.module('../hatchet/client.js', () => ({
  isHatchetEnabled: () => true,
  getHatchetClient: () => ({
    event: { push: mockEventPush },
    runNoWait: mockRunNoWait,
  }),
}));

const { createWebhookRoutes } = await import('../routes/webhooks.js');

// ── Fake EventBus (no filesystem) ───────────────────────────────

class FakeEventBus {
  events: PipelineEvent[] = [];
  private listeners: Array<(event: PipelineEvent) => void> = [];

  on(_event: string, fn: (event: PipelineEvent) => void) {
    this.listeners.push(fn);
    return this;
  }

  async publish(event: PipelineEvent) {
    this.events.push(event);
    for (const fn of this.listeners) fn(event);
  }
}

// ── Helpers ─────────────────────────────────────────────────────

const TEST_CONFIG = {
  branch: {
    pipeline_prefix: 'pipeline/',
    integration_prefix: 'integration/',
    main: 'main',
  },
  webhook_secret: undefined,
} as any;

function makeReviewPayload(overrides: {
  reviewState?: string;
  headRef?: string;
  prNumber?: number;
  action?: string;
} = {}) {
  return {
    action: overrides.action ?? 'submitted',
    review: {
      state: overrides.reviewState ?? 'changes_requested',
      body: 'Please fix the naming conventions.',
      user: { login: 'reviewer-alice' },
    },
    pull_request: {
      number: overrides.prNumber ?? 42,
      html_url: 'https://github.com/test/repo/pull/42',
      head: { ref: overrides.headRef ?? 'integration/my-feature' },
      base: { ref: 'main' },
    },
  };
}

function makeMergedPRPayload(headRef = 'integration/my-feature') {
  return {
    action: 'closed',
    pull_request: {
      merged: true,
      number: 99,
      html_url: 'https://github.com/test/repo/pull/99',
      head: { ref: headRef },
      base: { ref: 'main' },
      merge_commit_sha: 'abc123',
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe('Webhook → PR Review Loop (E2E)', () => {
  let app: Hono;
  let eventBus: FakeEventBus;

  beforeEach(() => {
    mockEventPush.mockReset();
    mockRunNoWait.mockReset();

    eventBus = new FakeEventBus();
    app = new Hono();
    app.route('/webhooks', createWebhookRoutes(eventBus as any, TEST_CONFIG));
  });

  // ── changes_requested → triggers review loop ──────────────

  it('triggers pr-review-loop workflow when reviewer requests changes', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify(makeReviewPayload({
        reviewState: 'changes_requested',
        headRef: 'integration/add-auth',
        prNumber: 42,
      })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('processed');
    expect(body.action).toBe('review_loop_triggered');
    expect(body.branch).toBe('add-auth');

    // EventBus should have published review_loop.started
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0].event_type).toBe('review_loop.started');
    expect(eventBus.events[0].data.branch).toBe('add-auth');
    expect(eventBus.events[0].data.pr_number).toBe(42);
    expect(eventBus.events[0].data.reviewer).toBe('reviewer-alice');

    // Hatchet should have been called to start the workflow
    expect(mockRunNoWait).toHaveBeenCalledTimes(1);
    const [workflowName, input] = mockRunNoWait.mock.calls[0] as [string, any, any];
    expect(workflowName).toBe('pr-review-loop');
    expect(input.branch).toBe('add-auth');
    expect(input.integrationBranch).toBe('integration/add-auth');
    expect(input.prNumber).toBe(42);
    expect(input.baseBranch).toBe('main');
  });

  // ── approved → emits pr.approved event ────────────────────

  it('emits pr.approved event when reviewer approves PR', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify(makeReviewPayload({
        reviewState: 'approved',
        headRef: 'integration/add-auth',
        prNumber: 42,
      })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('processed');
    expect(body.action).toBe('pr_approved');

    // EventBus should have published review_loop.completed
    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0].event_type).toBe('review_loop.completed');
    expect(eventBus.events[0].data.reason).toBe('approved');

    // Hatchet event.push should have been called with pr.approved
    expect(mockEventPush).toHaveBeenCalledTimes(1);
    const [eventName, eventData] = mockEventPush.mock.calls[0] as [string, any];
    expect(eventName).toBe('pr.approved');
    expect(eventData.prNumber).toBe(42);
    expect(eventData.branch).toBe('add-auth');

    // runNoWait should NOT have been called (no new workflow for approvals)
    expect(mockRunNoWait).toHaveBeenCalledTimes(0);
  });

  // ── Ignores non-integration branches ──────────────────────

  it('ignores reviews on non-integration branches', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify(makeReviewPayload({
        reviewState: 'changes_requested',
        headRef: 'feature/some-feature',
      })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('not an integration branch');

    expect(eventBus.events).toHaveLength(0);
    expect(mockRunNoWait).toHaveBeenCalledTimes(0);
    expect(mockEventPush).toHaveBeenCalledTimes(0);
  });

  // ── Ignores non-submitted actions ─────────────────────────

  it('ignores non-submitted review actions', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify(makeReviewPayload({ action: 'edited' })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('not a submitted review');
  });

  // ── Ignores comment-only reviews ──────────────────────────

  it('ignores comment-only reviews (not changes_requested or approved)', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify(makeReviewPayload({
        reviewState: 'commented',
        headRef: 'integration/feat',
      })),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('review state: commented');
  });

  // ── Merged PR flow still works ────────────────────────────

  it('processes merged integration PR correctly', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify(makeMergedPRPayload('integration/deploy-fix')),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('processed');
    expect(body.branch).toBe('deploy-fix');
    expect(body.pr_number).toBe(99);

    expect(eventBus.events).toHaveLength(1);
    expect(eventBus.events[0].event_type).toBe('integration.pr.merged');
    expect(eventBus.events[0].data.branch).toBe('deploy-fix');
    expect(eventBus.events[0].data.merge_commit_sha).toBe('abc123');
  });

  // ── HMAC signature validation ─────────────────────────────

  it('rejects invalid HMAC signature when secret is configured', async () => {
    const configWithSecret = { ...TEST_CONFIG, webhook_secret: 'my-secret' };
    const securedApp = new Hono();
    securedApp.route('/webhooks', createWebhookRoutes(eventBus as any, configWithSecret));

    const res = await securedApp.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
        'X-Hub-Signature-256': 'sha256=invalid',
      },
      body: JSON.stringify(makeReviewPayload()),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid signature');
  });

  it('rejects missing signature header when secret is configured', async () => {
    const configWithSecret = { ...TEST_CONFIG, webhook_secret: 'my-secret' };
    const securedApp = new Hono();
    securedApp.route('/webhooks', createWebhookRoutes(eventBus as any, configWithSecret));

    const res = await securedApp.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify(makeReviewPayload()),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Missing X-Hub-Signature-256 header');
  });

  // ── Unknown event types ───────────────────────────────────

  it('ignores unknown GitHub event types', async () => {
    const res = await app.request('/webhooks/github', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'star',
      },
      body: JSON.stringify({ action: 'created' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ignored');
    expect(body.reason).toBe('event type: star');
  });
});
