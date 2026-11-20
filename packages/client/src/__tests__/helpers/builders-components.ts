import type { AgentTemplate, Message, PRDetail, PRReviewThread } from '@funny/shared';

/**
 * Typed fixtures and DOM narrowing for component tests and stories, so a
 * fixture names only what it is about and needs no type assertion.
 */

/** A complete `Message` (a user message in thread `t1`); overrides win. */
export function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'user',
    content: '',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete `AgentTemplate` (a personal template of `u1`); overrides win. */
export function buildAgentTemplate(overrides: Partial<AgentTemplate> = {}): AgentTemplate {
  return {
    id: 'tpl-1',
    userId: 'u1',
    name: 'Template',
    systemPromptMode: 'append',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete `PRDetail` (open, mergeable, no checks); overrides win. */
export function buildPRDetail(overrides: Partial<PRDetail> = {}): PRDetail {
  return {
    number: 1,
    title: 'Pull request',
    body: '',
    state: 'open',
    draft: false,
    merged: false,
    mergeable_state: 'mergeable',
    html_url: 'https://github.com/acme/repo/pull/1',
    additions: 0,
    deletions: 0,
    changed_files: 0,
    commits: 0,
    head: { ref: 'feature', sha: 'abc123' },
    base: { ref: 'main' },
    user: null,
    review_decision: null,
    checks: [],
    checks_passed: 0,
    checks_failed: 0,
    checks_pending: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A complete `PRReviewThread` (unresolved, no comments, no line); overrides win. */
export function buildReviewThread(overrides: Partial<PRReviewThread> = {}): PRReviewThread {
  return {
    id: 1,
    path: 'src/a.ts',
    line: null,
    original_line: null,
    side: 'RIGHT',
    start_line: null,
    is_resolved: false,
    is_outdated: false,
    comments: [],
    ...overrides,
  };
}

/**
 * A complete `DOMRect` for `getBoundingClientRect` stubs: every field not
 * given is 0. Only the fields given are meaningful (no derived geometry),
 * matching the partial literals the stubs used to cast.
 */
export function buildRect(fields: Partial<Omit<DOMRect, 'toJSON'>> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    ...fields,
    toJSON: () => fields,
  };
}

/**
 * A complete `IntersectionObserverEntry` for driving a stubbed observer's
 * callback: not intersecting, zero ratio and empty rects unless given.
 */
export function buildIntersectionEntry(
  fields: Partial<IntersectionObserverEntry> = {},
): IntersectionObserverEntry {
  return {
    boundingClientRect: buildRect(),
    intersectionRatio: 0,
    intersectionRect: buildRect(),
    isIntersecting: false,
    rootBounds: null,
    target: document.createElement('div'),
    time: 0,
    ...fields,
  };
}

/** A complete `ResizeObserverEntry` whose content rect has `height`. */
export function buildResizeEntry(height: number): ResizeObserverEntry {
  return {
    target: document.createElement('div'),
    contentRect: buildRect({ height }),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
}

/** An inert `IntersectionObserver`, the second argument of an observer callback. */
export function buildIntersectionObserver(): IntersectionObserver {
  return {
    root: null,
    rootMargin: '0px',
    scrollMargin: '0px',
    thresholds: [0],
    disconnect: () => {},
    observe: () => {},
    takeRecords: () => [],
    unobserve: () => {},
  };
}

/**
 * Narrow `node` to an instance of `type`, failing the test when it is
 * something else (instead of asserting the type and failing later).
 */
export function expectInstance<T extends EventTarget>(
  node: EventTarget | null | undefined,
  type: abstract new (...args: never[]) => T,
): T {
  if (!(node instanceof type)) {
    throw new Error(`expected a ${type.name}, got ${String(node)}`);
  }
  return node;
}
