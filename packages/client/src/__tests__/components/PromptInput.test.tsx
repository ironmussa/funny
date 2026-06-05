import { screen, fireEvent, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { PromptInput } from '@/components/PromptInput';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';
import { ThreadProvider } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

import { renderWithProviders } from '../helpers/render';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/lib/api', async () => {
  const { okAsync } = await import('neverthrow');
  return {
    api: {
      listBranches: vi
        .fn()
        .mockReturnValue(okAsync({ branches: [], defaultBranch: 'main', currentBranch: 'main' })),
      listWorktrees: vi.fn().mockReturnValue(okAsync([])),
      listSkills: vi.fn().mockReturnValue(okAsync({ skills: [] })),
      remoteUrl: vi.fn().mockReturnValue(okAsync({ url: '' })),
      browseFiles: vi.fn().mockReturnValue(okAsync({ entries: [] })),
      getProfile: vi.fn().mockReturnValue(okAsync({ hasAssemblyaiKey: false })),
      listQueue: vi.fn().mockReturnValue(okAsync([])),
      updateQueuedMessage: vi
        .fn()
        .mockImplementation((_threadId: string, messageId: string, content: string) =>
          okAsync({
            ok: true,
            queuedCount: 1,
            message: { id: messageId, threadId: 't1', content },
          }),
        ),
      cancelQueuedMessage: vi.fn().mockReturnValue(okAsync({ ok: true, queuedCount: 0 })),
    },
  };
});

vi.mock('@/components/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

// Mock PromptEditor with a simple textarea to avoid TipTap contentEditable complexities
let mockEditorContent = '';
vi.mock('@/components/prompt-editor/PromptEditor', () => {
  const { forwardRef, useImperativeHandle, useState, useRef, useEffect } = require('react');
  return {
    PromptEditor: forwardRef(function MockPromptEditor(props: any, ref: any) {
      const [value, setValue] = useState('');
      const valueRef = useRef(value);
      valueRef.current = value;

      useImperativeHandle(ref, () => ({
        getJSON: () => ({
          type: 'doc',
          content: valueRef.current
            ? [{ type: 'paragraph', content: [{ type: 'text', text: valueRef.current }] }]
            : [],
        }),
        setContent: (content: any) => {
          let text = '';
          if (typeof content === 'string') {
            text = content;
          } else if (content?.content?.[0]?.content?.[0]?.text) {
            text = content.content[0].content[0].text;
          }
          setValue(text);
          valueRef.current = text;
          mockEditorContent = text;
        },
        getText: () => valueRef.current,
        focus: () => {},
        clear: () => {
          setValue('');
          valueRef.current = '';
          mockEditorContent = '';
        },
        isEmpty: () => !valueRef.current,
      }));

      // Sync external content back
      useEffect(() => {
        if (mockEditorContent && !value) {
          setValue(mockEditorContent);
        }
      }, [value]);

      return (
        <textarea
          data-testid="prompt-editor"
          role="textbox"
          aria-label="Message"
          value={value}
          onChange={(e: any) => {
            setValue(e.target.value);
            valueRef.current = e.target.value;
            mockEditorContent = e.target.value;
            props.onChange?.();
          }}
          onKeyDown={(e: any) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              props.onSubmit?.();
            }
          }}
          placeholder={props.placeholder}
          disabled={props.disabled}
        />
      );
    }),
  };
});

// Mock serialize to work with the mock editor's simple JSON
vi.mock('@/components/prompt-editor/serialize', () => ({
  serializeEditorContent: (json: any) => {
    const text = json?.content?.[0]?.content?.[0]?.text ?? '';
    return { text, fileReferences: [], symbolReferences: [], slashCommand: undefined };
  },
}));

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  mockEditorContent = '';
  useAppStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'Test',
        path: '/tmp/test',
        userId: 'user-1',
        createdAt: '',
        sortOrder: 0,
      },
    ],
    selectedProjectId: 'p1',
    selectedThreadId: null,
    activeThread: null,
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('PromptInput', () => {
  test('Enter key triggers onSubmit with prompt text', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello agent' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      'Hello agent',
      expect.objectContaining({ model: 'opus-4.8', mode: 'autoEdit' }),
      undefined,
    );
  });

  test('Shift+Enter does not trigger submit', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('empty prompt cannot be submitted', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('stop button shown when running=true, send button when not', () => {
    const onStop = vi.fn();

    // Running state with empty textarea — stop button visible
    const { unmount } = renderWithProviders(
      <PromptInput onSubmit={vi.fn()} onStop={onStop} running={true} />,
    );
    expect(screen.getAllByLabelText('prompt.stopAgent').length).toBeGreaterThan(0);
    unmount();

    // Not running — send button visible (no stop button)
    renderWithProviders(<PromptInput onSubmit={vi.fn()} running={false} />);
    expect(screen.queryByLabelText('prompt.stopAgent')).toBeNull();
  });

  test('submit clears the textarea', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'task' } });
    expect(textarea.value).toBe('task');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('submit preserves textarea when onSubmit returns false', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my task' } });
    expect(textarea.value).toBe('my task');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // The editor is cleared optimistically and only restored after onSubmit
    // resolves false (an extra microtask + re-render later), so poll for the
    // restored value instead of asserting synchronously — a bare expect here
    // races the restore and reads '' intermittently.
    await waitFor(() => expect(textarea.value).toBe('my task'));
  });

  test('textarea is disabled when loading=true', () => {
    renderWithProviders(<PromptInput onSubmit={vi.fn()} loading={true} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  test('shows all queued messages above the prompt', async () => {
    vi.mocked(api.listQueue).mockReturnValueOnce(
      okAsync([
        {
          id: 'q1',
          threadId: 'thread-1',
          content: 'Primer follow-up',
          sortOrder: 0,
          createdAt: '',
        },
        {
          id: 'q2',
          threadId: 'thread-1',
          content: 'Segundo follow-up',
          sortOrder: 1,
          createdAt: '',
        },
      ]),
    );

    renderWithProviders(<PromptInput onSubmit={vi.fn()} queuedCount={2} />, {
      threadId: 'thread-1',
    });

    await waitFor(() => {
      expect(screen.getByText('Primer follow-up')).toBeInTheDocument();
      expect(screen.getByText('Segundo follow-up')).toBeInTheDocument();
    });
  });

  test('can edit a queued message', async () => {
    vi.mocked(api.listQueue).mockReturnValueOnce(
      okAsync([
        { id: 'q1', threadId: 'thread-1', content: 'Texto original', sortOrder: 0, createdAt: '' },
      ]),
    );

    renderWithProviders(<PromptInput onSubmit={vi.fn()} queuedCount={1} />, {
      threadId: 'thread-1',
    });

    await waitFor(() => expect(screen.getByText('Texto original')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('queue-edit-q1'));
    fireEvent.change(screen.getByTestId('queue-edit-textarea-q1'), {
      target: { value: 'Texto actualizado' },
    });
    fireEvent.click(screen.getByTestId('queue-save-q1'));

    await waitFor(() => {
      expect(api.updateQueuedMessage).toHaveBeenCalledWith('thread-1', 'q1', 'Texto actualizado');
      expect(screen.getByText('Texto actualizado')).toBeInTheDocument();
    });
  });

  test('can delete a queued message', async () => {
    vi.mocked(api.listQueue).mockReturnValueOnce(
      okAsync([
        {
          id: 'q1',
          threadId: 'thread-1',
          content: 'Borrar este mensaje',
          sortOrder: 0,
          createdAt: '',
        },
      ]),
    );

    renderWithProviders(<PromptInput onSubmit={vi.fn()} queuedCount={1} />, {
      threadId: 'thread-1',
    });

    await waitFor(() => expect(screen.getByText('Borrar este mensaje')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('queue-delete-q1'));

    await waitFor(() => {
      expect(api.cancelQueuedMessage).toHaveBeenCalledWith('thread-1', 'q1');
      expect(screen.queryByText('Borrar este mensaje')).toBeNull();
    });
  });

  test('regression bug 2: switching threads clears the previous thread queue immediately', async () => {
    // Seed two threads with distinct queues. Without the fix, the local
    // queuedMessages state would carry from thread A into thread B's render
    // window before the new fetch resolves, briefly showing A's messages
    // under B's input bar.
    useThreadStore.setState({
      queuedCountByThread: { 'thread-a': 1, 'thread-b': 1 },
    } as any);

    vi.mocked(api.listQueue).mockImplementation((tid: string) => {
      if (tid === 'thread-a') {
        return okAsync([
          {
            id: 'qa',
            threadId: 'thread-a',
            content: 'mensaje SOLO de A',
            sortOrder: 0,
            createdAt: '',
          },
        ]);
      }
      if (tid === 'thread-b') {
        // Defer B's fetch so we can observe the intermediate render state.
        return new Promise(() => {}) as any;
      }
      return okAsync([]);
    });

    // Controlled threadId via a stateful host so rerender swaps the provider
    // without remounting Router/TooltipProvider (which can't be nested).
    function Host({ threadId }: { threadId: string }) {
      return (
        <ThreadProvider threadId={threadId}>
          <PromptInput onSubmit={vi.fn()} queuedCount={1} />
        </ThreadProvider>
      );
    }

    const { rerender } = renderWithProviders(<Host threadId="thread-a" />, {
      threadId: 'thread-a',
    });

    await waitFor(() => expect(screen.getByText('mensaje SOLO de A')).toBeInTheDocument());

    // Switch to thread B — its fetch is pending, so the previous thread's
    // messages must NOT remain visible during the transition.
    rerender(<Host threadId="thread-b" />);

    await waitFor(() => expect(screen.queryByText('mensaje SOLO de A')).toBeNull());
  });

  test('regression bug 1: queue stays visible after switching away and back to a thread', async () => {
    // queuedCountByThread is the persistent source of truth — even if the
    // payload's queuedCount field is stale/missing (because the thread was
    // unloaded from threadDataById), the queue must still render when we
    // come back.
    useThreadStore.setState({
      queuedCountByThread: { 'thread-a': 2 },
      // Intentionally leave threadDataById empty so the payload path
      // returns 0; the fallback to queuedCountByThread must kick in.
      threadDataById: {},
    } as any);

    vi.mocked(api.listQueue).mockReturnValue(
      okAsync([
        {
          id: 'qa1',
          threadId: 'thread-a',
          content: 'cola persistida 1',
          sortOrder: 0,
          createdAt: '',
        },
        {
          id: 'qa2',
          threadId: 'thread-a',
          content: 'cola persistida 2',
          sortOrder: 1,
          createdAt: '',
        },
      ]),
    );

    // Caller passes queuedCount=0 (e.g. because activeThread doesn't have it)
    // — the hook must still discover the count via queuedCountByThread and
    // render the queue.
    renderWithProviders(<PromptInput onSubmit={vi.fn()} queuedCount={0} />, {
      threadId: 'thread-a',
    });

    await waitFor(() => {
      expect(screen.getByText('cola persistida 1')).toBeInTheDocument();
      expect(screen.getByText('cola persistida 2')).toBeInTheDocument();
    });
  });
});
