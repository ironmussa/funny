import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { UserProfile } from '@funny/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { MemoryRouter } from 'react-router-dom';

import { mockT } from '../helpers/mock-i18n';

const generate = vi.fn();
mock.module('@/data/thread-recap/api', () => ({
  threadRecapApi: { generate },
  UTILITY_MODEL_UNAVAILABLE: 'utility-model-unavailable',
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import { ThreadRecapCard } from '@/components/thread/ThreadRecapCard';
import { writeProfile } from '@/data/profile/queries';
import { useAuthStore } from '@/stores/auth-store';
import { useThreadOpenStore } from '@/stores/thread-read-store';
import { useUIStore } from '@/stores/ui-store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const NOW = Date.now();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const thread = (id: string) => ({ id, userId: 'user-1', createdAt: minutesAgo(120) });

function open(threadId: string, openedAt = NOW) {
  useThreadOpenStore.setState((s) => ({
    byThread: {
      ...s.byThread,
      [threadId]: {
        readAt: minutesAgo(20),
        openedAt,
        createdAt: minutesAgo(120),
        newestMessageId: 'm9',
        newestActivityAt: minutesAgo(1),
      },
    },
  }));
}

function seedProfile() {
  writeProfile({
    userId: 'user-1',
    gitName: null,
    gitEmail: null,
    providerKeys: {},
    hasGithubToken: false,
    hasAssemblyaiKey: false,
    hasMinimaxApiKey: false,
    setupCompleted: true,
    defaultEditor: null,
    useInternalEditor: null,
    terminalShell: null,
    toolPermissions: null,
    theme: null,
    runnerInviteToken: null,
    utilityModel: null,
    threadRecapEnabled: true,
    threadRecapMinAbsenceMinutes: 5,
  } as UserProfile);
}

const renderCard = (id: string) =>
  render(
    <MemoryRouter>
      <ThreadRecapCard thread={thread(id)} />
    </MemoryRouter>,
  );

beforeEach(() => {
  generate.mockReset();
  installTestDataLayer();
  seedProfile();
  useAuthStore.setState({ user: { id: 'user-1' } as never });
  useThreadOpenStore.setState({ byThread: {} });
  useUIStore.setState({ dismissedRecaps: {}, recapHintOpenKey: null });
});
afterEach(() => resetTestDataLayer());

describe('ThreadRecapCard', () => {
  test('shows a skeleton, then the recap as plain text', async () => {
    let resolve!: (v: { recap: string; newestMessageId: string }) => void;
    generate.mockReturnValue(
      ResultAsync.fromSafePromise(
        new Promise<{ recap: string; newestMessageId: string }>((r) => {
          resolve = r;
        }),
      ),
    );
    open('t1');
    renderCard('t1');

    expect(await screen.findByTestId('thread-recap-loading')).toBeInTheDocument();
    await act(async () =>
      resolve({ recap: 'Edited **two** files. [x](http://e)', newestMessageId: 'm9' }),
    );

    const text = await screen.findByTestId('thread-recap-text');
    expect(text).toHaveTextContent('Edited **two** files. [x](http://e)');
    expect(screen.getByTestId('thread-recap-card').querySelector('a, strong')).toBeNull();
  });

  test('dismissing hides the card for that newest message', async () => {
    generate.mockReturnValue(okAsync({ recap: 'Did things.', newestMessageId: 'm9' }));
    open('t1');
    const { unmount } = renderCard('t1');

    fireEvent.click(await screen.findByTestId('thread-recap-dismiss'));
    expect(screen.queryByTestId('thread-recap-card')).toBeNull();
    expect(useUIStore.getState().dismissedRecaps['t1:m9']).toBe(true);

    unmount();
    open('t1', NOW + 1000);
    renderCard('t1');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('thread-recap-card')).toBeNull();
  });

  test('a failure shows no card and nothing else', async () => {
    generate.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'HTTP 502' }));
    open('t1');
    const { container } = renderCard('t1');

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  test('a missing utility model credential shows the hint once per session', async () => {
    generate.mockReturnValue(errAsync({ type: 'INTERNAL', message: 'utility-model-unavailable' }));
    open('t1');
    const first = renderCard('t1');

    expect(await screen.findByTestId('thread-recap-hint')).toBeInTheDocument();
    expect(screen.getByTestId('thread-recap-hint-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-recap-card')).toBeNull();
    first.unmount();

    // Reopening the same thread later this session: no hint again.
    open('t1', NOW + 1000);
    const again = renderCard('t1');
    await new Promise((r) => setTimeout(r, 20));
    expect(again.container).toBeEmptyDOMElement();
  });
});
