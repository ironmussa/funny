import { describe, expect, test } from 'bun:test';

import {
  createToolOutputPreview,
  nextToolOutputPreviewLength,
  TOOL_OUTPUT_COLLAPSED_CHARACTERS,
  TOOL_OUTPUT_EXPANDED_CHARACTERS,
} from '../tool-output-preview';

describe('native tool-output previews', () => {
  test('keeps a one-megabyte tool result out of the initial native render', () => {
    const content = `${'x'.repeat(1_000_000)}tail-marker`;
    const preview = createToolOutputPreview(content);

    expect(preview.content).toHaveLength(TOOL_OUTPUT_COLLAPSED_CHARACTERS);
    expect(preview.content).not.toContain('tail-marker');
    expect(preview.remainingCharacters).toBe(content.length - TOOL_OUTPUT_COLLAPSED_CHARACTERS);
  });

  test('reveals large results incrementally and never exceeds their length', () => {
    const total = 1_000_000;
    const secondWindow = nextToolOutputPreviewLength(TOOL_OUTPUT_COLLAPSED_CHARACTERS, total);

    expect(secondWindow).toBe(TOOL_OUTPUT_EXPANDED_CHARACTERS);
    expect(nextToolOutputPreviewLength(768_000, total)).toBe(total);
    expect(createToolOutputPreview('complete')).toEqual({
      content: 'complete',
      remainingCharacters: 0,
      visibleCharacters: 8,
    });
  });
});
