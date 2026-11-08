import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Schema } from '@tiptap/pm/model';
import { findSuggestionMatch } from '@tiptap/suggestion';
import { createRef, StrictMode } from 'react';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  getSuggestionLoadingLabel,
  PromptEditor,
  type PromptEditorHandle,
  WORKFLOW_SUGGESTION_MATCH_OPTIONS,
} from '@/components/prompt-editor/PromptEditor';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<{ api: Record<string, unknown> }>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      browseFiles: vi.fn(async () => ({
        isOk: () => true,
        value: { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], truncated: false },
      })),
    },
  };
});

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

  test('shows the placeholder while disabled', () => {
    // Regression: the read-only prompt dock in the thread preparation view
    // rendered empty because TipTap hides placeholders on non-editable editors.
    render(<PromptEditor placeholder="Next prompt" disabled />);
    expect(
      screen.getByTestId('prompt-editor').querySelector('[data-placeholder="Next prompt"]'),
    ).not.toBeNull();
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

  test('moves the @ menu selection with the arrow keys instead of stalling', async () => {
    const ref = createRef<PromptEditorHandle>();
    const onHistoryNavigate = vi.fn(() => true);

    render(<PromptEditor ref={ref} cwd="/repo" onHistoryNavigate={onHistoryNavigate} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current?.insertText('@');
    });

    const editor = screen.getByTestId('prompt-editor');
    await screen.findByTestId('mention-item-src/a.ts');
    expect(screen.getByTestId('mention-item-src/a.ts')).toHaveClass('bg-accent');

    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByTestId('mention-item-src/b.ts')).toHaveClass('bg-accent'),
    );

    fireEvent.keyDown(editor, { key: 'ArrowUp' });
    await waitFor(() =>
      expect(screen.getByTestId('mention-item-src/a.ts')).toHaveClass('bg-accent'),
    );

    // An open menu owns the arrow keys — history navigation must stay out of it.
    expect(onHistoryNavigate).not.toHaveBeenCalled();
  });

  test('selects the highlighted @ menu item with Enter', async () => {
    const ref = createRef<PromptEditorHandle>();
    const onSubmit = vi.fn();

    render(<PromptEditor ref={ref} cwd="/repo" onSubmit={onSubmit} />);

    await waitFor(() => expect(ref.current).not.toBeNull());
    act(() => {
      ref.current?.insertText('@');
    });

    const editor = screen.getByTestId('prompt-editor');
    await screen.findByTestId('mention-item-src/a.ts');
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(screen.getByTestId('mention-item-src/b.ts')).toHaveClass('bg-accent'),
    );
    fireEvent.keyDown(editor, { key: 'Enter' });

    await waitFor(() => {
      const paragraph = ref.current?.getJSON()?.content?.[0];
      expect(paragraph?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fileMention',
            attrs: expect.objectContaining({ path: 'src/b.ts' }),
          }),
        ]),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('selecting a slash command with Enter keeps the text after the caret', async () => {
    const ref = createRef<PromptEditorHandle>();

    // StrictMode calls state updaters twice. Running the insert from inside one
    // re-applied the stale range and deleted text after the chip.
    render(
      <StrictMode>
        <PromptEditor
          ref={ref}
          sdkSlashCommands={['implement']}
          commandProvider="codex"
          onSubmit={vi.fn()}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(ref.current).not.toBeNull());
    const editorEl = screen.getByTestId('prompt-editor') as HTMLElement & {
      editor: { commands: { setTextSelection: (pos: number) => boolean } };
    };
    act(() => {
      ref.current?.insertText(' docs/plan.md');
      // Put the caret back at the start, then type the command before the text.
      editorEl.editor.commands.setTextSelection(1);
      ref.current?.insertText('/imple');
    });

    await screen.findByTestId('slash-item-implement');
    fireEvent.keyDown(editorEl, { key: 'Enter' });

    await waitFor(() => {
      const paragraph = ref.current?.getJSON()?.content?.[0];
      expect(paragraph?.content?.[0]).toEqual(
        expect.objectContaining({
          type: 'slashCommand',
          attrs: expect.objectContaining({ id: 'implement' }),
        }),
      );
    });
    expect(ref.current?.getText()).toMatch(/ docs\/plan\.md$/);
  });
});

describe('buildSlashSuggestionItems', () => {
  test.each([{ sdkCommands: [] }, { sdkCommands: ['security-review'] }])(
    'prioritizes security-review before the result cap with SDK commands %j',
    ({ sdkCommands }) => {
      const skills = [
        ...Array.from({ length: 60 }, (_, i) => ({ name: `skill-${i}`, kind: 'skill' as const })),
        { name: 'security-review', kind: 'slash-command' as const },
      ];
      const items = buildSlashSuggestionItems({
        skills,
        sdkCommands,
        query: '',
        commandProvider: 'claude',
      });
      expect(items).toHaveLength(50);
      expect(items[0]).toMatchObject({ id: 'security-review', type: 'slash' });
      expect(items.filter((item) => item.id === 'security-review')).toHaveLength(1);
      expect(
        buildSlashSuggestionItems({
          skills,
          sdkCommands,
          query: 'security',
          commandProvider: 'claude',
        }).map((item) => item.id),
      ).toEqual(['security-review']);
    },
  );

  test('offers native Codex commands before a session starts', () => {
    const items = buildSlashSuggestionItems({
      skills: [],
      sdkCommands: [],
      query: 'compact',
      commandProvider: 'codex',
    });
    expect(items).toEqual([
      {
        id: 'compact',
        label: 'compact',
        description: 'Compact the current conversation context',
        type: 'slash',
      },
    ]);
    expect(
      buildSlashSuggestionItems({
        skills: [],
        sdkCommands: [],
        query: 'compact',
        commandProvider: 'gemini',
      }),
    ).toEqual([]);
  });

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
