/**
 * The issue's text a read-only role reads from a file (it has no network):
 * bounded, and never part of the prompt.
 */
import { describe, expect, test } from 'bun:test';

import {
  issueInputs,
  issueInstruction,
  issueMarkdown,
} from '../../../services/factory/factory-issue-text.js';

describe('issueMarkdown', () => {
  test('the title, body and comments, oldest first', () => {
    const text = issueMarkdown(9, {
      title: 'Crash',
      body: 'It crashes.',
      comments: [
        { author: 'a', body: 'first' },
        { author: 'b', body: 'second' },
      ],
    });
    expect(text).toContain('# Issue #9: Crash');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  test('a long body and a long thread are cut', () => {
    const text = issueMarkdown(9, {
      title: 'Long',
      body: 'x'.repeat(20_000),
      comments: Array.from({ length: 30 }, (_, i) => ({ author: `u${i}`, body: `c${i}` })),
    });
    expect(text).toContain('[… cut: 8000 more characters]');
    expect(text).toContain('_10 older comments not shown._');
    expect(text).not.toContain('## Comment by u0\n');
    expect(text).toContain('## Comment by u29');
  });
});

describe('issueInputs and issueInstruction', () => {
  test('a readable issue is a role input the prompt points at', () => {
    const issue = { title: 'T', body: 'B', comments: [] };
    expect(Object.keys(issueInputs(3, issue).roleInputs ?? {})).toEqual(['issue.md']);
    expect(issueInstruction(3, issue)).toContain('$FUNNY_ROLE_INPUTS/issue.md');
    expect(issueInstruction(3, issue)).not.toContain('B');
  });

  test('an unreadable one sends nothing and says so', () => {
    expect(issueInputs(3, null)).toEqual({});
    expect(issueInstruction(3, null)).toContain('could not be read');
  });
});
