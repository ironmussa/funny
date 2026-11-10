import { act, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  promptProps: null as null | Record<string, any>,
  sendMessage: vi.fn(),
  appendOptimisticMessage: vi.fn(),
}));

vi.mock('@/components/PromptInput', () => ({
  PromptInput: (props: Record<string, any>) => {
    mocks.promptProps = props;
    return <div data-testid="prompt-input-stub" />;
  },
}));
vi.mock('@/components/AvailableMcpServers', () => ({ AvailableMcpServers: () => null }));
vi.mock('@/lib/api', () => ({ api: { sendMessage: mocks.sendMessage } }));
vi.mock('@/stores/thread-context', () => ({ useThreadMessages: () => [] }));
vi.mock('@/stores/thread-store', () => ({
  useThreadStore: {
    getState: () => ({
      appendOptimisticMessage: mocks.appendOptimisticMessage,
      rollbackOptimisticMessage: vi.fn(),
    }),
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ThreadIdleStarter } from '@/components/thread/ThreadIdleStarter';
import { TooltipProvider } from '@/components/ui/tooltip';

const MANIFEST =
  '<referenced-files>\n<file path="src/a.ts" />\n<folder path="docs"></folder>\n</referenced-files>\n\nReview these';

function renderStarter(initialPrompt: string) {
  render(
    <TooltipProvider>
      <ThreadIdleStarter
        activeThread={{ id: 't-1', projectId: 'p-1', provider: 'claude', initialPrompt } as any}
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
