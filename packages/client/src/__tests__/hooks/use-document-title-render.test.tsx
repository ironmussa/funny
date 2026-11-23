import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

/**
 * `useDocumentTitle` runs in the app root. The loaded payload (`activeThread`)
 * is replaced on every streaming flush, so selecting it whole re-rendered the
 * root at stream rate. It must re-render only when a field the title reads
 * changes.
 */

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
);

function loaded(overrides: Partial<ThreadWithMessages> = {}): ThreadWithMessages {
  return buildThreadWithMessages({
    id: 'scratch-1',
    projectId: '',
    isScratch: true,
    mode: 'local',
    title: 'regex test',
    ...overrides,
  });
}

beforeEach(() => installTestDataLayer());
afterEach(() => {
  resetTestDataLayer();
  useThreadStore.setState({ selectedThreadId: null, activeThread: null, threadDataById: {} });
});

describe('useDocumentTitle re-renders', () => {
  test('a streaming flush of the loaded payload does not re-render; a title change does', () => {
    useThreadStore.setState({ activeThread: loaded() });
    let renders = 0;
    renderHook(
      () => {
        renders++;
        useDocumentTitle();
      },
      { wrapper },
    );
    expect(document.title).toBe('regex test — funny');
    const before = renders;

    // Streaming flushes: new payload objects, new messages, same title fields.
    for (let i = 0; i < 5; i++) {
      act(() => {
        const prev = useThreadStore.getState().activeThread!;
        useThreadStore.setState({
          activeThread: {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: `m${i}`,
                threadId: prev.id,
                role: 'assistant',
                content: `chunk ${i}`,
                timestamp: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        });
      });
    }
    expect(renders).toBe(before);

    act(() => {
      useThreadStore.setState({ activeThread: loaded({ title: 'renamed' }) });
    });
    expect(renders).toBe(before + 1);
    expect(document.title).toBe('renamed — funny');
  });
});
