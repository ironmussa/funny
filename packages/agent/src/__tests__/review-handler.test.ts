/**
 * ReviewEventAdapter tests — verifies that GitHub PR events trigger code reviews.
 * Uses dependency injection (config.reviewer) instead of mock.module to avoid
 * mock leaking between test files.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

import { ReviewEventAdapter } from '../adapters/outbound/review-event.adapter.js';
import type { PipelineEvent } from '../core/types.js';
import { EventBus } from '../infrastructure/event-bus.js';

const TEST_DIR = join(import.meta.dir, '..', '..', '.test-tmp-review-handler');

// ── Mock review result ──────────────────────────────────────────

const mockReviewResult = {
  prNumber: 42,
  status: 'approved' as const,
  summary: 'Code looks great.',
  findings: [],
  duration_ms: 1500,
  model: 'claude-sonnet-4-5-20250929',
};

// ── Helpers ──────────────────────────────────────────────────────

function makeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    event_type: 'session.review_requested',
    request_id: 'review-42',
    timestamp: new Date().toISOString(),
    data: {
      branch: 'feature/login',
      prNumber: 42,
      projectPath: '/tmp/test-repo',
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('ReviewEventAdapter', () => {
  let eventBus: EventBus;
  let handler: ReviewEventAdapter;
  let mockReview: ReturnType<typeof mock>;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });

    mockReview = mock(() => Promise.resolve(mockReviewResult));

    eventBus = new EventBus(TEST_DIR);
    handler = new ReviewEventAdapter(eventBus, {
      projectPath: '/tmp/test-repo',
      reviewer: { review: mockReview } as any,
    });
    handler.start();
  });

  afterEach(() => {
    handler.stop();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('triggers review on session.review_requested event', async () => {
    const event = makeEvent();
    await eventBus.publish(event);

    // Give the async handler time to execute
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReview).toHaveBeenCalledTimes(1);
    expect(mockReview).toHaveBeenCalledWith(
      '/tmp/test-repo',
      42,
      expect.objectContaining({ post: true }),
    );
  });

  it('publishes review.completed event after successful review', async () => {
    const received: PipelineEvent[] = [];
    eventBus.on('event', (evt) => {
      if (evt.event_type !== 'session.review_requested') {
        received.push(evt);
      }
    });

    await eventBus.publish(makeEvent());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const completedEvent = received.find((e) => e.event_type === 'reaction.triggered');
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.data.type).toBe('review_completed');
    expect(completedEvent!.data.status).toBe('approved');
    expect(completedEvent!.data.prNumber).toBe(42);
  });

  it('publishes error event when review fails', async () => {
    mockReview.mockImplementation(() => Promise.reject(new Error('GitHub API down')));

    const received: PipelineEvent[] = [];
    eventBus.on('event', (evt) => {
      if (evt.event_type !== 'session.review_requested') {
        received.push(evt);
      }
    });

    await eventBus.publish(makeEvent());
    await new Promise((resolve) => setTimeout(resolve, 50));

    const errorEvent = received.find((e) => e.event_type === 'reaction.triggered');
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.data.type).toBe('review_failed');
    expect(errorEvent!.data.error).toBe('GitHub API down');
  });

  it('ignores events without prNumber', async () => {
    const event = makeEvent({ data: { branch: 'feature/login' } });
    await eventBus.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReview).not.toHaveBeenCalled();
  });

  it('does not trigger after stop()', async () => {
    handler.stop();

    await eventBus.publish(makeEvent());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReview).not.toHaveBeenCalled();
  });

  it('uses projectPath from event data when available', async () => {
    const event = makeEvent({
      data: {
        branch: 'feature/login',
        prNumber: 99,
        projectPath: '/custom/repo/path',
      },
    });

    await eventBus.publish(event);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReview).toHaveBeenCalledWith('/custom/repo/path', 99, expect.anything());
  });
});
