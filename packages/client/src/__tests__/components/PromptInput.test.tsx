import { screen, fireEvent, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { PromptInput } from '@/components/PromptInput';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

import { renderWithProviders } from '../helpers/render';

// ── Mocks ───────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
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
    getAuthToken: vi.fn(() => null),
    getAuthMode: vi.fn(() => 'local'),
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
          mockEditorContent = text;
        },
        getText: () => valueRef.current,
        focus: () => {},
        clear: () => {
          setValue('');
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
    return { text, fileReferences: [], slashCommand: undefined };
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
        userId: '__local__',
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
  test('Enter key triggers onSubmit with prompt text', () => {
    const onSubmit = vi.fn();
    renderWithProviders(<PromptInput onSubmit={onSubmit} />);

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Hello agent' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(
      'Hello agent',
      expect.objectContaining({ model: 'opus', mode: 'autoEdit' }),
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
    expect(textarea.value).toBe('my task');
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

    renderWithProviders(<PromptInput onSubmit={vi.fn()} threadId="thread-1" queuedCount={2} />);

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

    renderWithProviders(<PromptInput onSubmit={vi.fn()} threadId="thread-1" queuedCount={1} />);

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

    renderWithProviders(<PromptInput onSubmit={vi.fn()} threadId="thread-1" queuedCount={1} />);

    await waitFor(() => expect(screen.getByText('Borrar este mensaje')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('queue-delete-q1'));

    await waitFor(() => {
      expect(api.cancelQueuedMessage).toHaveBeenCalledWith('thread-1', 'q1');
      expect(screen.queryByText('Borrar este mensaje')).toBeNull();
    });
  });
});
