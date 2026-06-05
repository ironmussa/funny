import { describe, expect, test } from 'vitest';

import { buildIssueThreadPrompt } from '@/lib/build-issue-thread-prompt';

describe('buildIssueThreadPrompt', () => {
  const repo = { owner: 'acme', repo: 'app' };

  test('includes title and URL but not issue body', () => {
    const prompt = buildIssueThreadPrompt(
      {
        number: 42,
        title: 'Fix login validation',
        labels: [{ name: 'bug', color: 'd73a4a' }],
      },
      repo,
    );

    expect(prompt).toContain('Fix GitHub issue #42: Fix login validation');
    expect(prompt).toContain('https://github.com/acme/app/issues/42');
    expect(prompt).toContain('Labels: bug');
    expect(prompt).not.toContain('Issue description');
    expect(prompt).not.toContain('client-side validation');
  });
});
