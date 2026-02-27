/**
 * PRReviewer tests — verifies the review flow using the agent layer
 * instead of direct ACP HTTP calls.
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';

import { PRReviewer } from '../agents/reviewer/reviewer.js';

// ── Mock helpers ─────────────────────────────────────────────────

const DEFAULT_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
+export function login() {
+  const password = "hardcoded123";
+  return eval(password);
+}`;

function createGitMocks(diffOverride?: string) {
  return {
    getPRInfo: mock(() =>
      Promise.resolve({
        match: (ok: any) => ok({ title: 'Add login feature', body: 'Implements OAuth login' }),
      }),
    ),
    getPRDiff: mock(() =>
      Promise.resolve({
        match: (ok: any) => ok(diffOverride ?? DEFAULT_DIFF),
      }),
    ),
    postPRReview: mock(() =>
      Promise.resolve({
        match: (ok: any) => ok(undefined),
      }),
    ),
  };
}

let gitMocks = createGitMocks();

mock.module('@funny/core/git', () => gitMocks);

// ── Mock process factory ─────────────────────────────────────────

let mockProcessMessages: any[] = [];

function createMockProcessFactory() {
  return {
    create: mock((_opts: any) => {
      const listeners: Record<string, Function[]> = {};
      return {
        on(event: string, listener: Function) {
          listeners[event] = listeners[event] || [];
          listeners[event].push(listener);
          return this;
        },
        removeAllListeners() {
          return this;
        },
        start() {
          // Emit messages async to simulate real process
          setTimeout(() => {
            for (const msg of mockProcessMessages) {
              listeners['message']?.forEach((fn) => fn(msg));
            }
            listeners['exit']?.forEach((fn) => fn(0));
          }, 10);
        },
        kill: mock(() => Promise.resolve()),
        exited: false,
      };
    }),
  };
}

function setMockLLMResponse(jsonResponse: object): void {
  const json = JSON.stringify(jsonResponse, null, 2);
  mockProcessMessages = [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'test-session',
      tools: [],
      model: 'claude-sonnet-4-5-20250929',
      cwd: '/tmp',
    },
    {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: '```json\n' + json + '\n```' }],
      },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1000,
      num_turns: 1,
      result: '```json\n' + json + '\n```',
      total_cost_usd: 0.01,
      session_id: 'test-session',
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────────

describe('PRReviewer', () => {
  let factory: ReturnType<typeof createMockProcessFactory>;

  beforeEach(() => {
    gitMocks = createGitMocks();
    mock.module('@funny/core/git', () => gitMocks);
    factory = createMockProcessFactory();
    mockProcessMessages = [];
  });

  it('returns approved when no findings', async () => {
    setMockLLMResponse({
      summary: 'Code looks great, no issues found.',
      findings: [],
    });

    const reviewer = new PRReviewer({ processFactory: factory as any });
    const result = await reviewer.review('/repo', 42);

    expect(result.status).toBe('approved');
    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe('Code looks great, no issues found.');
    expect(result.prNumber).toBe(42);
    expect(gitMocks.postPRReview).toHaveBeenCalled();
  });

  it('returns changes_requested when critical findings exist', async () => {
    setMockLLMResponse({
      summary: 'Found security issues.',
      findings: [
        {
          severity: 'critical',
          category: 'security',
          file: 'src/auth.ts',
          line: 3,
          description: 'Hardcoded password',
          suggestion: 'Use environment variables',
        },
      ],
    });

    const reviewer = new PRReviewer({ processFactory: factory as any });
    const result = await reviewer.review('/repo', 42);

    expect(result.status).toBe('changes_requested');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].category).toBe('security');
  });

  it('returns commented when only medium findings exist', async () => {
    setMockLLMResponse({
      summary: 'Minor concerns.',
      findings: [
        {
          severity: 'medium',
          category: 'performance',
          file: 'src/utils.ts',
          description: 'Could use memoization',
        },
      ],
    });

    const reviewer = new PRReviewer({ processFactory: factory as any });
    const result = await reviewer.review('/repo', 42);

    expect(result.status).toBe('commented');
    expect(result.findings).toHaveLength(1);
  });

  it('returns approved for empty diff without calling LLM', async () => {
    gitMocks = createGitMocks('');
    mock.module('@funny/core/git', () => gitMocks);

    const reviewer = new PRReviewer({ processFactory: factory as any });
    const result = await reviewer.review('/repo', 42);

    expect(result.status).toBe('approved');
    expect(result.summary).toBe('Empty diff — nothing to review.');
    expect(factory.create).not.toHaveBeenCalled();
  });

  it('does not post to GitHub when post=false', async () => {
    setMockLLMResponse({
      summary: 'All good.',
      findings: [],
    });

    const reviewer = new PRReviewer({ processFactory: factory as any });
    await reviewer.review('/repo', 42, { post: false });

    expect(gitMocks.postPRReview).not.toHaveBeenCalled();
  });

  it('passes provider and model to the process factory', async () => {
    setMockLLMResponse({
      summary: 'OK.',
      findings: [],
    });

    const reviewer = new PRReviewer({ processFactory: factory as any });
    await reviewer.review('/repo', 42, { provider: 'claude', model: 'opus' });

    expect(factory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'claude',
        model: 'opus',
      }),
    );
  });

  it('handles unparseable LLM output gracefully', async () => {
    mockProcessMessages = [
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        num_turns: 1,
        result: 'This is not JSON at all, just random text.',
        total_cost_usd: 0.01,
        session_id: 'test-session',
      },
    ];

    const reviewer = new PRReviewer({ processFactory: factory as any });
    const result = await reviewer.review('/repo', 42);

    expect(result.summary).toBe('Could not parse review output.');
    expect(result.findings).toHaveLength(0);
    expect(gitMocks.postPRReview).toHaveBeenCalled();
  });

  it('handles process error gracefully', async () => {
    const errorFactory = {
      create: mock(() => {
        const listeners: Record<string, Function[]> = {};
        return {
          on(event: string, listener: Function) {
            listeners[event] = listeners[event] || [];
            listeners[event].push(listener);
            return this;
          },
          removeAllListeners() {
            return this;
          },
          start() {
            setTimeout(() => {
              listeners['error']?.forEach((fn) => fn(new Error('LLM connection failed')));
              listeners['exit']?.forEach((fn) => fn(1));
            }, 10);
          },
          kill: mock(() => Promise.resolve()),
          exited: false,
        };
      }),
    };

    const reviewer = new PRReviewer({ processFactory: errorFactory as any });

    await expect(reviewer.review('/repo', 42)).rejects.toThrow('LLM connection failed');
  });
});
