import { describe, expect, test } from 'vitest';

import { claudeMessagePresentation } from '@/lib/claude-message-presentation';

describe('claudeMessagePresentation', () => {
  test.each([
    'Explain <system-reminder>hello</system-reminder>',
    '```xml\n<system-reminder>hello</system-reminder>\n```',
    '<system-reminder>incomplete',
    '<other>hello</other>',
    'Normal user message',
  ])('preserves ordinary text: %s', (text) => {
    expect(claudeMessagePresentation(text)).toEqual({ kind: 'message', text });
  });

  test('normalizes command names and preserves multiline arguments', () => {
    expect(
      claudeMessagePresentation(
        '<command-message>review</command-message><command-name>review</command-name><command-args>first\nsecond</command-args>',
      ),
    ).toEqual({ kind: 'command', text: '/review first\nsecond' });
  });

  test('keeps commands recognizable even when marked automatic', () => {
    expect(
      claudeMessagePresentation(
        '<command-message>review</command-message><command-name>/review</command-name>',
        true,
      ),
    ).toEqual({ kind: 'command', text: '/review' });
  });
});
