import { describe, test, expect, vi, beforeEach, mock } from 'bun:test';

import { mocked } from '@funny/test-kit';
import { screen, fireEvent, waitFor, type RenderResult } from '@testing-library/react';
import { okAsync, ResultAsync } from 'neverthrow';

import { expectInstance } from '../helpers/builders-components';
import { installTestDataLayer } from '../helpers/data-layer-harness';
import { flushAsyncUpdates, renderWithProviders } from '../helpers/render';

const actualLibApiSystem = { ...(await import('@/lib/api/system')) };
mock.module('@/lib/api/system', () => {
  const actual = actualLibApiSystem;
  return {
    ...actual,
    systemApi: {
      ...actual.systemApi,
      providerSetupStatus: vi.fn(),
      installProviderTool: vi.fn(),
      getProviders: vi.fn(() =>
        okAsync({
          providers: [],
          activeBuiltins: null,
          availableProviders: null,
          hasRunner: false,
        }),
      ),
      getAcpModels: vi.fn(() =>
        okAsync({ ok: true, models: [], currentModelId: null, discoveredAt: 0 }),
      ),
      getOpenCodeModels: vi.fn(() =>
        okAsync({ ok: true, models: [], currentModelId: null, discoveredAt: 0 }),
      ),
    },
  };
});

// The model picker, sandbox toggle and branch context load these on mount.
mock.module('@/lib/api/infra', () => ({
  infraApi: {
    listInfraConnections: vi.fn(() => okAsync({ connections: [] })),
    getProjectSandbox: vi.fn(() => okAsync({ settings: null })),
  },
}));
mock.module('@/lib/api/profile', () => ({
  profileApi: { getProfile: vi.fn(() => okAsync({})), updateProfile: vi.fn(() => okAsync({})) },
}));
const actualLibApiProjects = { ...(await import('@/lib/api/projects')) };
mock.module('@/lib/api/projects', () => {
  const actual = actualLibApiProjects;
  return {
    projectsApi: {
      ...actual.projectsApi,
      listBranches: vi.fn(() =>
        okAsync({ branches: [], remoteBranches: [], defaultBranch: 'main', currentBranch: 'main' }),
      ),
    },
  };
});

// ── Mocks ───────────────────────────────────────────────────────

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// One api mock object, shared with the threadsApi mock below.
const apiMock = {
  listBranches: vi
    .fn()
    .mockReturnValue(okAsync({ branches: [], defaultBranch: 'main', currentBranch: 'main' })),
  listWorktrees: vi.fn().mockReturnValue(okAsync([])),
  listSkills: vi.fn().mockReturnValue(okAsync({ skills: [] })),
  listAgentResources: vi.fn().mockReturnValue(okAsync({ resources: [] })),
  listWorkflows: vi.fn().mockReturnValue(okAsync({ workflows: [], warnings: [] })),
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
};

mock.module('@/lib/api', () => ({ api: apiMock }));

// The queue data layer calls threadsApi directly; route it to the mocked api.
mock.module('@/lib/api/threads', () => ({ threadsApi: apiMock }));

mock.module('@/components/ImageLightbox', () => ({
  ImageLightbox: () => null,
}));

// Mock PromptEditor with a simple textarea to avoid TipTap contentEditable complexities
let mockEditorContent = '';
mock.module('@/components/prompt-editor/PromptEditor', () => {
  const {
    forwardRef,
    useImperativeHandle,
    useState,
    useRef,
    useEffect,
    useLayoutEffect,
  } = require('react');
  return {
    PromptEditor: forwardRef(function MockPromptEditor(props: any, ref: any) {
      const [value, setValue] = useState('');
      const valueRef = useRef(value);
      useLayoutEffect(() => {
        valueRef.current = value;
      }, [value]);

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
          aria-label="Message"
          value={value}
          onChange={(e: any) => {
            setValue(e.target.value);
            valueRef.current = e.target.value;
            mockEditorContent = e.target.value;
            props.onChange?.();
          }}
          onKeyDown={(e: any) => {
            if (e.key === 'ArrowUp' && props.onHistoryNavigate?.('previous')) {
              e.preventDefault();
              return;
            }
            if (e.key === 'ArrowDown' && props.onHistoryNavigate?.('next')) {
              e.preventDefault();
              return;
            }
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
mock.module('@/components/prompt-editor/serialize', () => ({
  serializeEditorContent: (json: any) => {
    const text = json?.content?.[0]?.content?.[0]?.text ?? '';
    return { text, fileReferences: [], symbolReferences: [], slashCommand: undefined };
  },
}));

const { PromptInput } = await import('@/components/PromptInput');
const { withProjects } = await import('@/data/projects/testing');
const { seedQueues } = await import('@/data/queue/testing');
const { buildThreadWithMessages } = await import('@/data/threads/testing');
const { api } = await import('@/lib/api');
const { systemApi } = await import('@/lib/api/system');
const { useAppStore } = await import('@/stores/app-store');
const { ThreadProvider } = await import('@/stores/thread-context');
const { useThreadStore } = await import('@/stores/thread-store');

// ── Setup ───────────────────────────────────────────────────────

/**
 * Render and let the mount-time loads (branches, skills, slash sources) land
 * inside act; without it they update PromptInput after a synchronous test has
 * already returned.
 */
async function renderPrompt(
  ...args: Parameters<typeof renderWithProviders>
): Promise<RenderResult> {
  const view = renderWithProviders(...args);
  await flushAsyncUpdates();
  return view;
}

beforeEach(() => {
  installTestDataLayer();
  mocked(systemApi.providerSetupStatus).mockReturnValue(
    okAsync({
      provider: 'claude',
      state: 'installed',
      auth: 'connected',
      installable: true,
      login: null,
    }),
  );
  mockEditorContent = '';
  useAppStore.setState(
    withProjects({
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
    }),
  );
  useThreadStore.setState({
    threadDataById: {},
  });
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('PromptInput', () => {
  test('mobile drawer header clicks do not refocus the prompt editor', async () => {
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(max-width: 767px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: () => false,
    }));
    const view = await renderPrompt(<PromptInput onSubmit={vi.fn()} />);
    try {
      const editor = screen.getByRole('textbox');
      fireEvent.click(screen.getByTestId('prompt-mode-select'));
      const title = await screen.findByRole('heading', { name: 'Mode' });
      fireEvent.click(title);
      expect(editor).not.toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() =>
        expect(screen.queryByTestId('prompt-selection-drawer')).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId('prompt-mode-select')).toHaveFocus();
    } finally {
      view.unmount();
      matchMedia.mockRestore();
    }
  });

  test('reserves context bar height before and after new-thread context loads', async () => {
    const onSubmit = vi.fn();
    const { rerender } = await renderPrompt(
      <PromptInput onSubmit={onSubmit} isNewThread newThreadContextBar={<span>Test</span>} />,
    );

    // jsdom has no layout engine; guard the minimum height that accommodates
    // the loaded repo/branch controls (20px line height + 4px padding).
    expect(screen.getByTestId('new-thread-context-bar')).toHaveClass('min-h-6');
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    rerender(
      <PromptInput
        onSubmit={onSubmit}
        isNewThread
        newThreadContextBar={<button className="py-0.5 text-sm">main</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'main' })).toBeInTheDocument();
    expect(screen.getByTestId('new-thread-context-bar')).toHaveClass('min-h-6');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  test('Enter key triggers onSubmit with prompt text', async () => {
    const onSubmit = vi.fn();
    await renderPrompt(<PromptInput onSubmit={onSubmit} />);

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

  test('uses the project default thinking level for a new thread', async () => {
    useAppStore.setState(
      withProjects({
        projects: [
          {
            id: 'p1',
            name: 'Test',
            path: '/tmp/test',
            userId: 'user-1',
            createdAt: '',
            sortOrder: 0,
            defaultProvider: 'codex',
            defaultModel: 'gpt-5.4',
            defaultEffort: 'medium',
          },
        ],
      }),
    );
    const onSubmit = vi.fn();
    await renderPrompt(<PromptInput onSubmit={onSubmit} isNewThread projectId="p1" />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Use the project defaults' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      'Use the project defaults',
      expect.objectContaining({
        provider: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      }),
      undefined,
    );
  });

  test('navigates this thread’s sent-message history with the arrow keys', async () => {
    useThreadStore.setState({
      threadDataById: {
        'thread-history': buildThreadWithMessages({
          id: 'thread-history',
          projectId: 'p1',
          mode: 'local',
          branch: 'main',
          status: 'idle',
          messages: [
            {
              id: 'user-1',
              threadId: 'thread-history',
              role: 'user',
              content: 'first prompt',
              timestamp: '2026-01-01T00:00:00.000Z',
            },
            {
              id: 'assistant-1',
              threadId: 'thread-history',
              role: 'assistant',
              content: 'response',
              timestamp: '2026-01-01T00:00:01.000Z',
            },
            {
              id: 'user-2',
              threadId: 'thread-history',
              role: 'user',
              content: 'latest prompt',
              timestamp: '2026-01-01T00:00:02.000Z',
            },
          ],
        }),
      },
    });

    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, { threadId: 'thread-history' });
    const textarea = expectInstance(screen.getByRole('textbox'), HTMLTextAreaElement);

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('latest prompt');

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('first prompt');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('latest prompt');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('');
  });

  test('restores the draft after navigating back to the end of message history', async () => {
    useThreadStore.setState({
      threadDataById: {
        'thread-history': buildThreadWithMessages({
          id: 'thread-history',
          projectId: 'p1',
          mode: 'local',
          branch: 'main',
          status: 'idle',
          messages: [
            {
              id: 'user-1',
              threadId: 'thread-history',
              role: 'user',
              content: 'previous prompt',
              timestamp: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      },
    });

    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, { threadId: 'thread-history' });
    const textarea = expectInstance(screen.getByRole('textbox'), HTMLTextAreaElement);
    fireEvent.change(textarea, { target: { value: 'unfinished draft' } });

    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    expect(textarea.value).toBe('previous prompt');

    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea.value).toBe('unfinished draft');
  });

  test('notifies the selected default provider on mount for new threads', async () => {
    useAppStore.setState(
      withProjects({
        projects: [
          {
            id: 'p1',
            name: 'Test',
            path: '/tmp/test',
            userId: 'user-1',
            createdAt: '',
            sortOrder: 0,
            defaultProvider: 'codex',
            defaultModel: 'gpt-5.5',
          },
        ],
        selectedProjectId: 'p1',
        selectedThreadId: null,
        activeThread: null,
      }),
    );
    const onProviderChange = vi.fn();

    await renderPrompt(
      <PromptInput
        onSubmit={vi.fn()}
        isNewThread
        projectId="p1"
        onProviderChange={onProviderChange}
      />,
    );

    await waitFor(() => expect(onProviderChange).toHaveBeenCalledWith('codex'));
    expect(onProviderChange).toHaveBeenCalledTimes(1);
  });

  test('loads new-thread skills from the chosen project instead of the previous thread', async () => {
    useAppStore.setState(
      withProjects({
        projects: [
          {
            id: 'p-old',
            name: 'Previous project',
            path: '/tmp/previous-project',
            userId: 'user-1',
            createdAt: '',
            sortOrder: 0,
          },
          {
            id: 'p-new',
            name: 'Google Live B2',
            path: '/tmp/google-live-b2',
            userId: 'user-1',
            createdAt: '',
            sortOrder: 1,
            defaultProvider: 'codex',
            defaultModel: 'gpt-5.5',
          },
        ],
        selectedProjectId: 'p-new',
      }),
    );
    useThreadStore.setState({
      threadDataById: {
        'old-thread': buildThreadWithMessages({
          id: 'old-thread',
          projectId: 'p-old',
          worktreePath: '/tmp/previous-project-worktree',
          provider: 'claude',
          model: 'opus-4.8',
          mode: 'worktree',
          branch: 'old-branch',
          status: 'idle',
          messages: [],
        }),
      },
    });

    await renderPrompt(<PromptInput onSubmit={vi.fn()} isNewThread projectId="p-new" />, {
      threadId: 'old-thread',
    });

    await waitFor(() =>
      expect(api.listAgentResources).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'p-new',
          projectPath: '/tmp/google-live-b2',
          provider: 'codex',
          model: 'gpt-5.5',
          phase: 'composer',
        }),
      ),
    );
    expect(api.listAgentResources).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p-old' }),
    );
  });

  test('Shift+Enter does not trigger submit', async () => {
    const onSubmit = vi.fn();
    await renderPrompt(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'line1' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('empty prompt cannot be submitted', async () => {
    const onSubmit = vi.fn();
    await renderPrompt(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('stop button shown when running=true, send button when not', async () => {
    const onStop = vi.fn();

    // Running state with empty textarea — stop button visible
    const { unmount } = await renderPrompt(
      <PromptInput onSubmit={vi.fn()} onStop={onStop} running={true} />,
    );
    expect(screen.getAllByLabelText('prompt.stopAgent').length).toBeGreaterThan(0);
    unmount();

    // Not running — send button visible (no stop button)
    await renderPrompt(<PromptInput onSubmit={vi.fn()} running={false} />);
    expect(screen.queryByLabelText('prompt.stopAgent')).toBeNull();
  });

  test('submit clears the textarea', async () => {
    const onSubmit = vi.fn();
    await renderPrompt(<PromptInput onSubmit={onSubmit} />);

    const textarea = expectInstance(screen.getByRole('textbox'), HTMLTextAreaElement);
    fireEvent.change(textarea, { target: { value: 'task' } });
    expect(textarea.value).toBe('task');

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  test('submit preserves textarea when onSubmit returns false', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    await renderPrompt(<PromptInput onSubmit={onSubmit} />);

    const textarea = expectInstance(screen.getByRole('textbox'), HTMLTextAreaElement);
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

  test('textarea is disabled when loading=true', async () => {
    await renderPrompt(<PromptInput onSubmit={vi.fn()} loading={true} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  test('uses a theme-aware contrasting border for attached image previews', async () => {
    await renderPrompt(
      <PromptInput
        onSubmit={vi.fn()}
        initialImages={[
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'ZmFrZQ==',
            },
          },
        ]}
      />,
    );

    expect(screen.getByRole('img', { name: 'Attachment 1' })).toHaveClass(
      'border-2',
      'border-foreground',
    );
  });

  test('shows all queued messages above the prompt', async () => {
    mocked(api.listQueue).mockReturnValueOnce(
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

    seedQueues({ 'thread-1': { count: 2 } });
    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, {
      threadId: 'thread-1',
    });

    await waitFor(() => {
      expect(screen.getByText('Primer follow-up')).toBeInTheDocument();
      expect(screen.getByText('Segundo follow-up')).toBeInTheDocument();
    });
  });

  test('can edit a queued message', async () => {
    mocked(api.listQueue).mockReturnValueOnce(
      okAsync([
        { id: 'q1', threadId: 'thread-1', content: 'Texto original', sortOrder: 0, createdAt: '' },
      ]),
    );

    seedQueues({ 'thread-1': { count: 1 } });
    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, {
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
    mocked(api.listQueue).mockReturnValueOnce(
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

    seedQueues({ 'thread-1': { count: 1 } });
    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, {
      threadId: 'thread-1',
    });

    await waitFor(() => expect(screen.getByText('Borrar este mensaje')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('queue-delete-q1'));

    await waitFor(() => {
      expect(api.cancelQueuedMessage).toHaveBeenCalledWith('thread-1', 'q1');
      expect(screen.queryByText('Borrar este mensaje')).not.toBeInTheDocument();
    });
  });

  test('regression bug 2: switching threads clears the previous thread queue immediately', async () => {
    // Seed two threads with distinct queues. Thread A's messages must never
    // render under thread B's input bar while B's fetch is in flight.
    seedQueues({ 'thread-a': { count: 1 }, 'thread-b': { count: 1 } });

    mocked(api.listQueue).mockImplementation((tid: string) => {
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
        return new ResultAsync(new Promise(() => {}));
      }
      return okAsync([]);
    });

    // Controlled threadId via a stateful host so rerender swaps the provider
    // without remounting Router/TooltipProvider (which can't be nested).
    function Host({ threadId }: { threadId: string }) {
      return (
        <ThreadProvider threadId={threadId}>
          <PromptInput onSubmit={vi.fn()} />
        </ThreadProvider>
      );
    }

    const { rerender } = await renderPrompt(<Host threadId="thread-a" />, {
      threadId: 'thread-a',
    });

    await waitFor(() => expect(screen.getByText('mensaje SOLO de A')).toBeInTheDocument());

    // Switch to thread B — its fetch is pending, so the previous thread's
    // messages must NOT remain visible during the transition.
    rerender(<Host threadId="thread-b" />);

    await waitFor(() => expect(screen.queryByText('mensaje SOLO de A')).not.toBeInTheDocument());
  });

  test('regression bug 1: queue stays visible after switching away and back to a thread', async () => {
    // The queue row outlives the thread payload: with the payload unloaded
    // from threadDataById, the queue must still render when we come back.
    seedQueues({ 'thread-a': { count: 2 } });
    useThreadStore.setState({ threadDataById: {} });

    mocked(api.listQueue).mockReturnValue(
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

    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, {
      threadId: 'thread-a',
    });

    await waitFor(() => {
      expect(screen.getByText('cola persistida 1')).toBeInTheDocument();
      expect(screen.getByText('cola persistida 2')).toBeInTheDocument();
    });
  });

  test('shows queued message preview while queue details are still loading', async () => {
    mocked(api.listQueue).mockReturnValueOnce(new ResultAsync(new Promise(() => {})));

    seedQueues({ 'thread-a': { count: 1, next: 'mensaje pendiente despues del refresh' } });
    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, {
      threadId: 'thread-a',
    });

    expect(screen.getByText('mensaje pendiente despues del refresh')).toBeInTheDocument();
    expect(screen.queryByText('Loading queued messages...')).toBeNull();
    expect(screen.getByTestId('queue-edit-preview-queued-message:thread-a')).toBeDisabled();
    expect(screen.getByTestId('queue-delete-preview-queued-message:thread-a')).toBeDisabled();
  });

  test('uses cached queued messages before refetching after a thread switch', async () => {
    seedQueues({
      'thread-a': {
        count: 1,
        stale: true,
        messages: [
          {
            id: 'qa1',
            threadId: 'thread-a',
            content: 'cola cacheada al volver',
            sortOrder: 0,
            createdAt: '',
          },
        ],
      },
    });
    mocked(api.listQueue).mockReturnValueOnce(new ResultAsync(new Promise(() => {})));

    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, {
      threadId: 'thread-a',
    });

    expect(screen.getByText('cola cacheada al volver')).toBeInTheDocument();
    expect(screen.queryByText('Loading queued messages...')).toBeNull();
  });

  test("regression: powerline uses the thread's own project, not the global selection", async () => {
    // In the live-columns grid each column renders its own PromptInput for a
    // different thread while the sidebar's global selectedProjectId points
    // elsewhere. The powerline must show the THREAD's project — otherwise
    // effectiveProject resolves to the (wrong/missing) global selection and the
    // bar collapses to a gray branch-only segment with no project name.
    useAppStore.setState(
      withProjects({
        projects: [
          {
            id: 'p1',
            name: 'Alpha',
            path: '/tmp/alpha',
            color: '#ff0000',
            userId: 'user-1',
            createdAt: '',
            sortOrder: 0,
          },
          {
            id: 'p2',
            name: 'Beta',
            path: '/tmp/beta',
            color: '#00ff00',
            userId: 'user-1',
            createdAt: '',
            sortOrder: 1,
          },
        ],
        // Global selection points at Beta…
        selectedProjectId: 'p2',
        selectedThreadId: null,
        activeThread: null,
      }),
    );

    // …but the column's thread belongs to Alpha.
    useThreadStore.setState({
      threadDataById: {
        'thread-alpha': buildThreadWithMessages({
          id: 'thread-alpha',
          projectId: 'p1',
          mode: 'local',
          branch: 'master',
          status: 'idle',
          messages: [],
        }),
      },
    });

    await renderPrompt(<PromptInput onSubmit={vi.fn()} />, { threadId: 'thread-alpha' });

    // Powerline shows Alpha (thread's project), never Beta (global selection).
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Beta')).toBeNull();
  });

  test('does not render a context percentage from Codex turn-aggregate usage', async () => {
    // Codex reports all input tokens consumed by a turn, including several
    // model requests made for tool calls. Old thread payloads can retain that
    // aggregate, but it is not the active context-window size.
    await renderPrompt(
      <PromptInput
        onSubmit={vi.fn()}
        threadOverride={{
          provider: 'codex',
          model: 'gpt-5.5',
          contextUsage: { cumulativeInputTokens: 1_360_000 },
        }}
      />,
      { threadId: 'codex-thread' },
    );

    expect(screen.queryByTestId('prompt-context-pct')).toBeNull();
  });

  test('renders a context percentage for providers that report a window snapshot', async () => {
    await renderPrompt(
      <PromptInput
        onSubmit={vi.fn()}
        threadOverride={{
          provider: 'claude',
          model: 'opus-4.8',
          contextUsage: { cumulativeInputTokens: 100_000 },
        }}
      />,
      { threadId: 'claude-thread' },
    );

    expect(screen.getByTestId('prompt-context-pct')).toHaveTextContent('10% de contexto');
  });
});

test('keeps the draft and attachments while the provider needs authentication', async () => {
  mocked(systemApi.providerSetupStatus).mockReturnValue(
    okAsync({
      provider: 'claude',
      state: 'installed',
      auth: 'required',
      installable: true,
      login: null,
    }),
  );
  const onSubmit = vi.fn();
  await renderPrompt(
    <PromptInput
      onSubmit={onSubmit}
      projectId="p1"
      initialImages={[
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'ZmFrZQ==' },
        },
      ]}
    />,
  );
  const attachment = screen.getByRole('img', { name: 'Attachment 1' });
  const textarea = expectInstance(screen.getByRole('textbox'), HTMLTextAreaElement);
  fireEvent.change(textarea, { target: { value: 'keep my task' } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  await screen.findByRole('dialog');
  expect(textarea.value).toBe('keep my task');
  expect(attachment).toBeInTheDocument();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('opens Pi setup before sending when the bundled SDK has no credentials', async () => {
  mocked(systemApi.providerSetupStatus).mockReturnValue(
    okAsync({ provider: 'pi', state: 'bundled', auth: 'required', installable: true, login: 'pi' }),
  );
  const onSubmit = vi.fn();
  await renderPrompt(
    <PromptInput
      onSubmit={onSubmit}
      projectId="p1"
      threadOverride={{ provider: 'pi', model: 'default' }}
    />,
  );
  const textarea = expectInstance(screen.getByRole('textbox'), HTMLTextAreaElement);
  fireEvent.change(textarea, { target: { value: 'Pi task' } });
  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  await screen.findByRole('dialog');
  expect(systemApi.providerSetupStatus).toHaveBeenCalledWith('pi', 'p1');
  expect(textarea.value).toBe('Pi task');
  expect(onSubmit).not.toHaveBeenCalled();
});

test('keeps image attachments per thread and restores them from the draft', async () => {
  const { useDraftStore } = await import('@/stores/draft-store');
  useDraftStore.setState({ drafts: {} });
  const ui = (threadId: string) => (
    <ThreadProvider threadId={threadId}>
      <PromptInput onSubmit={vi.fn()} projectId="p1" />
    </ThreadProvider>
  );
  const view = await renderPrompt(ui('thread-a'), { threadId: null });

  const input = expectInstance(screen.getByTestId('prompt-file-input'), HTMLInputElement);
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [image] } });
  await screen.findByRole('img', { name: 'Attachment 1' });

  // Thread B has no draft: the image from A must not follow.
  view.rerender(ui('thread-b'));
  await flushAsyncUpdates();
  await waitFor(() => expect(screen.queryByRole('img', { name: 'Attachment 1' })).toBeNull());
  expect(useDraftStore.getState().drafts['thread-a']?.images).toHaveLength(1);

  // Back to A: the image is restored from the draft.
  view.rerender(ui('thread-a'));
  await flushAsyncUpdates();
  await screen.findByRole('img', { name: 'Attachment 1' });
  view.unmount();
});
