import { beforeEach, describe, expect, test, vi } from 'bun:test';

import { mocked } from '@funny/test-kit';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';
import type { ReactElement, ReactNode } from 'react';

import { AgentResultCard, AgentStoppedCard } from '@/components/thread/AgentStatusCards';
import { CopyThreadButton } from '@/components/thread/CopyThreadButton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { buildThreadWithMessages } from '@/data/threads/testing';
import { api } from '@/lib/api';

import { buildMessage } from '../helpers/builders-components';

const render = (ui: ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

vi.mock('@/lib/api', () => ({ api: { getThread: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
  Trans: ({ i18nKey, components }: { i18nKey: string; components: { time: ReactNode } }) => (
    <>
      {i18nKey} {components.time}
    </>
  ),
}));
const { showError } = (() => ({ showError: vi.fn() }))();
vi.mock('sonner', () => ({ toast: { error: showError, success: vi.fn() } }));
const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

describe('completed thread actions', () => {
  test('shows the actual completion time, with seconds, in local time', () => {
    const completedAt = '2026-10-30T20:42:00.000Z';
    const { container } = render(
      <AgentResultCard status="completed" cost={0} duration={0} completedAt={completedAt} />,
    );
    const time = container.querySelector('time');
    expect(time).toHaveAttribute('datetime', completedAt);
    expect(time).toHaveTextContent(
      new Date(completedAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  });

  test('does not invent a completion time when it is unavailable', () => {
    const { container } = render(<AgentResultCard status="completed" cost={0} duration={0} />);
    expect(container.querySelector('time')).toBeNull();
  });

  test('derives the processing time from the latest prompt when the live duration is missing', () => {
    render(
      <AgentResultCard
        status="completed"
        cost={0}
        duration={0}
        startedAt="2026-10-30T20:40:00.000Z"
        completedAt="2026-10-30T20:41:05.000Z"
      />,
    );
    expect(screen.getByTestId('agent-run-duration')).toHaveTextContent('duration.minutesSeconds');
  });

  test('shows the same run info at the end of a stopped thread', () => {
    render(
      <AgentStoppedCard
        startedAt="2026-10-30T20:40:00.000Z"
        completedAt="2026-10-30T20:40:12.000Z"
        copyThreadId="thread-1"
      />,
    );
    expect(screen.getByTestId('agent-run-duration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy latest prompt and response' })).toBeEnabled();
  });

  test('copies only the latest prompt onwards, without tool cards', async () => {
    mocked(api.getThread).mockReturnValue(
      okAsync(
        buildThreadWithMessages({
          messages: [
            buildMessage({ role: 'user', content: 'Older prompt' }),
            buildMessage({ role: 'assistant', content: 'Older answer' }),
            buildMessage({ role: 'user', content: 'Latest prompt' }),
            {
              ...buildMessage({ role: 'assistant', content: 'Final answer' }),
              toolCalls: [
                { id: 'tc1', messageId: 'm1', name: 'Read', input: '{}', output: 'File contents' },
              ],
            },
          ],
        }),
      ),
    );
    render(<CopyThreadButton threadId="thread-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy latest prompt and response' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Latest response copied' })).toBeEnabled(),
    );
    expect(screen.getByRole('button').querySelector('.lucide-check')).toHaveClass('text-green-600');
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: 'Copy latest prompt and response' }),
        ).toBeEnabled(),
      { timeout: 3000 },
    );
    expect(api.getThread).toHaveBeenCalledWith('thread-1');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Latest prompt'));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('Older prompt'));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('Older answer'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Final answer'));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('File contents'));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining('Tool: Read'));
  });

  test('reports fetch failures without copying partial history', async () => {
    mocked(api.getThread).mockReturnValue(errAsync({ type: 'INTERNAL', message: 'Offline' }));
    render(<CopyThreadButton threadId="thread-1" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy latest prompt and response' })).toBeEnabled();
  });

  test('reports clipboard rejection without showing success', async () => {
    mocked(api.getThread).mockReturnValue(okAsync(buildThreadWithMessages()));
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    render(<CopyThreadButton threadId="thread-1" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Latest response copied' })).toBeNull();
  });

  test('hides a completed turn bar until its section is hovered', () => {
    render(
      <AgentResultCard
        status="completed"
        cost={0}
        duration={0}
        completedAt="2026-10-30T20:42:00.000Z"
        revealForSection="u1"
      />,
    );
    const card = screen.getByTestId('agent-result-card');
    expect(card).toHaveAttribute('data-turn-end-for', 'u1');
    expect(card).toHaveClass('opacity-0', 'data-[hovered]:opacity-100');
  });

  test('keeps failed runs visible so their error is never hidden', () => {
    render(
      <AgentResultCard status="failed" cost={0} duration={0} error="Boom" revealForSection="u1" />,
    );
    const card = screen.getByTestId('agent-result-card');
    expect(card).not.toHaveAttribute('data-turn-end-for');
    expect(card).not.toHaveClass('opacity-0');
  });

  test('keeps a stopped turn visible with its stop time', () => {
    render(
      <AgentResultCard
        status="stopped"
        cost={0}
        duration={0}
        completedAt="2026-10-30T20:42:00.000Z"
        revealForSection="u1"
      />,
    );
    const card = screen.getByTestId('agent-result-card');
    expect(card).toHaveTextContent('thread.taskStoppedAt');
    expect(card).not.toHaveClass('opacity-0');
  });
});
