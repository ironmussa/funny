import { describe, expect, test } from 'bun:test';

import {
  createMessageContentPreview,
  MESSAGE_CONTENT_COLLAPSED_CHARACTERS,
  MESSAGE_CONTENT_EXPANDED_CHARACTERS,
  nextMessageContentPreviewLength,
} from '../message-content-preview';

describe('native message-content previews', () => {
  test('bounds long messages before native text or markdown layout', () => {
    const content = `${'m'.repeat(10_000)}tail-marker`;
    const preview = createMessageContentPreview(content);

    expect(preview.content).toHaveLength(MESSAGE_CONTENT_COLLAPSED_CHARACTERS);
    expect(preview.content).not.toContain('tail-marker');
    expect(preview.remainingCharacters).toBe(content.length - MESSAGE_CONTENT_COLLAPSED_CHARACTERS);
  });

  test('expands in bounded steps', () => {
    expect(nextMessageContentPreviewLength(MESSAGE_CONTENT_COLLAPSED_CHARACTERS, 10_000)).toBe(
      MESSAGE_CONTENT_EXPANDED_CHARACTERS,
    );
    expect(nextMessageContentPreviewLength(MESSAGE_CONTENT_EXPANDED_CHARACTERS, 10_000)).toBe(
      8_000,
    );
    expect(nextMessageContentPreviewLength(8_000, 10_000)).toBe(10_000);
  });
});
