import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { act, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

interface StarterMocks {
  promptProps: null | Record<string, any>;
  sendMessage: Mock<(...args: any[]) => any>;
  appendOptimisticMessage: Mock<(...args: any[]) => any>;
}

const mocks = ((): StarterMocks => ({
  promptProps: null,
  sendMessage: vi.fn(),
  appendOptimisticMessage: vi.fn(),
}))();

mock.module('@/components/PromptInput', () => ({
  PromptInput: (props: Record<string, any>) => {
    mocks.promptProps = props;
    return <div data-testid="prompt-input-stub" />;
  },
}));
mock.module('@/components/AvailableMcpServers', () => ({ AvailableMcpServers: () => null }));
mock.module('@/lib/api', () => ({ api: { sendMessage: mocks.sendMessage } }));
mock.module('@/stores/thread-context', () => ({ useThreadMessages: () => [] }));
mock.module('@/stores/thread-store', () => ({
  useThreadStore: {
    getState: () => ({
      appendOptimisticMessage: mocks.appendOptimisticMessage,
      rollbackOptimisticMessage: vi.fn(),
    }),
  },
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

const { ThreadIdleStarter } = await import('@/components/thread/ThreadIdleStarter');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { buildThreadWithMessages } = await import('@/data/threads/testing');

const MANIFEST =
  '<referenced-files>\n<file path="src/a.ts" />\n<folder path="docs"></folder>\n</referenced-files>\n\nReview these';

function renderStarter(initialPrompt: string) {
  render(
    <TooltipProvider>
      <ThreadIdleStarter
        activeThread={buildThreadWithMessages({
          id: 't-1',
          projectId: 'p-1',
          provider: 'claude',
          initialPrompt,
        })}
      />
    </TooltipProvider>,
  );
}

describe('ThreadIdleStarter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.promptProps = null;
    mocks.sendMessage.mockReturnValue(okAsync({ ok: true }));
  });

  test('shows the stored attachments as chips and only the text in the editor', () => {
    renderStarter(MANIFEST);

    expect(screen.getByTestId('idle-thread-attachment-src/a.ts')).toBeInTheDocument();
    expect(screen.getByTestId('idle-thread-attachment-docs')).toBeInTheDocument();
    expect(mocks.promptProps?.initialPrompt).toBe('Review these');
  });

  test('puts the manifest back and forwards staged uploads on send', async () => {
    renderStarter(MANIFEST);

    await act(() =>
      mocks.promptProps!.onSubmit('Review these now', {
        model: 'sonnet',
        mode: 'autoEdit',
        stagedUploads: ['s-1'],
      }),
    );

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1));
    const [threadId, content, opts] = mocks.sendMessage.mock.calls[0];
    expect(threadId).toBe('t-1');
    expect(content).toBe(
      '<referenced-files>\n<file path="src/a.ts" />\n<folder path="docs"></folder>\n</referenced-files>\n\nReview these now',
    );
    expect(opts.stagedUploads).toEqual(['s-1']);
  });

  test('leaves prompts without attachments as they are', () => {
    renderStarter('Just text');
    expect(screen.queryByTestId('idle-thread-attachments')).toBeNull();
    expect(mocks.promptProps?.initialPrompt).toBe('Just text');
  });
});
