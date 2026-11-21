import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { Thread, ThreadEvent } from '@funny/shared';
import { screen } from '@testing-library/react';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';
import { renderWithProviders } from '../helpers/render';

const { VirtualRowContent } = await import('@/components/thread/MemoizedMessageList.renderers');
const { getThreadsData } = await import('@/data/threads/store');
const { buildThread, buildThreadWithMessages } = await import('@/data/threads/testing');
const { useThreadStore } = await import('@/stores/thread-store');

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
};

function thread(status: Thread['status']): Thread {
  return buildThread({ title: 't1', status, stage: 'backlog' });
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

// The row itself always renders. Hiding the latest stop while the thread is
// still stopped happens upstream in `buildGroupedRenderItems` (see
// render-items.test.ts), whose status comes from the thread row via
// `useThreadCore`, so a stale `running` payload cannot double the card.
describe('StoppedOutcomeRow', () => {
  test('stays in the timeline once the thread runs again', async () => {
    getThreadsData().upsertFresh([thread('running')]);
    useThreadStore.setState({
      threadDataById: {
        t1: { ...buildThreadWithMessages(thread('running')), threadEvents: [stopEvent] },
      },
    });
    renderStopRow();
    expect(await screen.findByTestId('agent-result-card')).toBeInTheDocument();
  });
});
