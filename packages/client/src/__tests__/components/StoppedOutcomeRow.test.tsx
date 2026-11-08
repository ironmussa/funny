import type { Thread, ThreadEvent } from '@funny/shared';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { VirtualRowContent } from '@/components/thread/MemoizedMessageList.renderers';
import { getThreadsData } from '@/data/threads/store';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';
import { renderWithProviders } from '../helpers/render';

const stopEvent: ThreadEvent = {
  id: 'ev-stop',
  threadId: 't1',
  type: 'turn_outcome',
  data: JSON.stringify({
    userMessageId: 'u1',
    status: 'stopped',
    completedAt: '2026-01-01T00:10:00.000Z',
  }),
  createdAt: '2026-01-01T00:10:00.000Z',
} as ThreadEvent;

function thread(status: Thread['status']): Thread {
  return {
    id: 't1',
    projectId: 'p1',
    title: 't1',
    mode: 'local',
    status,
    stage: 'backlog',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as Thread;
}

function renderStopRow() {
  renderWithProviders(
    <VirtualRowContent
      row={{
        type: 'item',
        key: 'ev-stop',
        item: { type: 'thread-event', event: stopEvent },
        itemIndex: 0,
      }}
      threadId="t1"
      snapshotMap={new Map()}
      isWaiting={false}
      onSend={() => {}}
      onOpenLightbox={() => {}}
      scrollToUserMessagePosition={() => {}}
    />,
  );
}

beforeEach(() => installTestDataLayer());
afterEach(() => {
  useThreadStore.setState({ threadDataById: {} });
  resetTestDataLayer();
});

describe('StoppedOutcomeRow', () => {
  test('a live stop leaves only the status tail card, even with a stale payload status', async () => {
    // The payload was loaded while running; only the row learned about the stop.
    getThreadsData().upsertFresh([thread('stopped')]);
    useThreadStore.setState({
      threadDataById: {
        t1: { ...thread('running'), messages: [], threadEvents: [stopEvent] } as ThreadWithMessages,
      },
    });
    renderStopRow();
    await waitFor(() => expect(screen.queryByTestId('agent-result-card')).not.toBeInTheDocument());
  });

  test('stays in the timeline once the thread runs again', async () => {
    getThreadsData().upsertFresh([thread('running')]);
    useThreadStore.setState({
      threadDataById: {
        t1: { ...thread('running'), messages: [], threadEvents: [stopEvent] } as ThreadWithMessages,
      },
    });
    renderStopRow();
    expect(await screen.findByTestId('agent-result-card')).toBeInTheDocument();
  });
});
