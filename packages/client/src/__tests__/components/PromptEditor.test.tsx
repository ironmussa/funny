import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Schema } from '@tiptap/pm/model';
import { findSuggestionMatch } from '@tiptap/suggestion';
import { createRef } from 'react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  getSuggestionLoadingLabel,
  PromptEditor,
  type PromptEditorHandle,
  WORKFLOW_SUGGESTION_MATCH_OPTIONS,
} from '@/components/prompt-editor/PromptEditor';

const rangeGetClientRectsDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getClientRects',
);
const rangeGetBoundingClientRectDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  'getBoundingClientRect',
);

beforeAll(() => {
  // ProseMirror reads the active text range's geometry while focusing. JSDOM
  // does not implement these Range methods, unlike browsers.
  Object.defineProperties(Range.prototype, {
    getClientRects: {
      configurable: true,
      value: () => [] as unknown as DOMRectList,
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 }) as DOMRect,
    },
  });
});

afterAll(() => {
  if (rangeGetClientRectsDescriptor) {
    Object.defineProperty(Range.prototype, 'getClientRects', rangeGetClientRectsDescriptor);
  } else {
    delete (Range.prototype as Partial<Range>).getClientRects;
  }
  if (rangeGetBoundingClientRectDescriptor) {
    Object.defineProperty(
      Range.prototype,
      'getBoundingClientRect',
      rangeGetBoundingClientRectDescriptor,
    );
  } else {
    delete (Range.prototype as Partial<Range>).getBoundingClientRect;
  }
});

describe('PromptEditor', () => {
  test('opts the prompt editor out of the global scroll fade mask', () => {
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => document.body,
    });

    try {
      render(<PromptEditor />);

      const editor = screen.getByTestId('prompt-editor');
      expect(editor).toHaveClass('overflow-y-auto');
      expect(editor).toHaveClass('scroll-fade-none');
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  test('selects a slash command without fragment conversion errors', async () => {
    const ref = createRef<PromptEditorHandle>();

    render(<PromptEditor ref={ref} sdkSlashCommands={['compact']} commandProvider="codex" />);

    await waitFor(() => expect(ref.current).not.toBeNull());

    act(() => {
      ref.current?.insertText('/');
    });

    fireEvent.mouseDown(await screen.findByTestId('slash-item-compact'));

    await waitFor(() => {
      const paragraph = ref.current?.getJSON()?.content?.[0];
      expect(paragraph?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'slashCommand',
            attrs: expect.objectContaining({ id: 'compact', label: 'compact' }),
          }),
        ]),
      );
    });
  });

  test('navigates forward through message history when the caret is at the end', async () => {
    const ref = createRef<PromptEditorHandle>();
    const onHistoryNavigate = vi.fn(() => true);

    render(<PromptEditor ref={ref} onHistoryNavigate={onHistoryNavigate} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current?.insertText('latest prompt');
    });

    fireEvent.keyDown(screen.getByTestId('prompt-editor'), { key: 'ArrowDown' });

    expect(onHistoryNavigate).toHaveBeenCalledWith('next');
  });
});

describe('buildSlashSuggestionItems', () => {
  test('returns SDK slash commands before skills have loaded', () => {
    const items = buildSlashSuggestionItems({
      skills: [],
      sdkCommands: ['compact', 'init'],
      query: '',
      commandProvider: 'claude',
    });

    expect(items.map((item) => item.id)).toEqual(['compact', 'init']);
    expect(items[0].description).toBe('Summarize the conversation to free up context');
  });

  test('dedupes skills and SDK commands while preserving skill descriptions', () => {
    const items = buildSlashSuggestionItems({
      skills: [{ name: 'fix-linear', description: 'Fix a Linear issue' }],
      sdkCommands: ['fix-linear', 'review'],
      query: 'fix',
      commandProvider: 'codex',
    });

    expect(items).toEqual([
      {
        id: 'fix-linear',
        label: 'fix-linear',
        description: 'Fix a Linear issue',
        type: 'slash',
      },
    ]);
  });

  test('keeps provider skills distinct from executable slash commands', () => {
    const items = buildSlashSuggestionItems({
      skills: [
        { name: 'openspec-propose', description: 'Create an OpenSpec proposal', kind: 'skill' },
        { name: 'opsx:propose', description: 'Create an OpenSpec proposal', kind: 'slash-command' },
      ],
      sdkCommands: [],
      query: 'propose',
      commandProvider: 'codex',
    });

    expect(items).toEqual([
      {
        id: 'openspec-propose',
        label: 'openspec-propose',
        description: 'Create an OpenSpec proposal',
        type: 'skill',
      },
      {
        id: 'opsx:propose',
        label: 'opsx:propose',
        description: 'Create an OpenSpec proposal',
        type: 'slash',
      },
    ]);
  });

  test('uses a generic loading label for slash suggestions', () => {
    expect(getSuggestionLoadingLabel('slash')).toEqual({
      key: 'prompt.loadingCommands',
      fallback: 'Loading commands...',
    });
  });
});

describe('buildWorkflowSuggestionItems', () => {
  const textSchema = new Schema({
    nodes: { doc: { content: 'text*' }, text: {} },
    marks: {},
  });

  function matchWorkflowTrigger(text: string) {
    const doc = textSchema.node('doc', null, [textSchema.text(text)]);
    return findSuggestionMatch({
      ...WORKFLOW_SUGGESTION_MATCH_OPTIONS,
      $position: doc.resolve(doc.content.size),
    });
  }

  test('matches double-chevron workflow triggers', () => {
    expect(matchWorkflowTrigger('>>fus')?.query).toBe('>fus');
    expect(matchWorkflowTrigger('text >>fus')?.query).toBe('>fus');
    expect(matchWorkflowTrigger('text>>fus')).toBeNull();
  });

  test('returns project workflows for the double-chevron menu', () => {
    const items = buildWorkflowSuggestionItems({
      workflows: [
        { name: 'fusion', description: 'Review and merge', source: 'built-in' },
        { name: 'release', source: 'user' },
      ],
      query: '',
    });

    expect(items).toEqual([
      {
        id: 'fusion',
        label: 'fusion',
        description: 'Review and merge',
        type: 'workflow',
      },
      {
        id: 'release',
        label: 'release',
        description: 'user workflow',
        type: 'workflow',
      },
    ]);
  });

  test('filters workflow names after the second chevron', () => {
    const items = buildWorkflowSuggestionItems({
      workflows: [
        { name: 'fusion', description: 'Review and merge' },
        { name: 'release', description: 'Ship changes' },
      ],
      query: '>fus',
    });

    expect(items.map((item) => item.id)).toEqual(['fusion']);
  });

  test('uses a workflow loading label', () => {
    expect(getSuggestionLoadingLabel('workflow')).toEqual({
      key: 'prompt.loadingWorkflows',
      fallback: 'Loading workflows...',
    });
  });
});
