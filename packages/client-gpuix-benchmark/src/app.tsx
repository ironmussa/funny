import {
  makeRendererBenchmarkFixtures,
  type RendererBenchmarkState,
} from '@funny/client-benchmark';
import { windowStartForVisibleRange } from '@funny/gpuix-ui/virtual-range';
import type { EventPayload } from '@gpuix/react';
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import { buildGpuixRows, gpuixFinalStateChecksum } from './model';

export const GPUIX_FIXTURES = makeRendererBenchmarkFixtures();
export const BENCHMARK_RETAINED_WINDOW_SIZE = 48;
const BENCHMARK_WINDOW_BUFFER = 12;

export interface GpuixBenchmarkController {
  switchThread: () => void;
  stream: () => void;
  input: () => void;
  snapshot: () => RendererBenchmarkState & {
    checksum: string;
    listId: number | null;
  };
}

function MessageRow({ row }: { row: ReturnType<typeof buildGpuixRows>[number] }) {
  return (
    <div
      testId={`message-${row.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        gap: 8,
        padding: 12,
        width: '100%',
        backgroundColor: row.role === 'user' ? '#202636' : '#151923',
      }}
    >
      <text
        style={{
          color: row.role === 'user' ? '#8ab4ff' : '#b7f7c2',
          fontWeight: 'bold',
        }}
      >
        {row.role}
      </text>
      <markdown source={row.markdown} />
      {row.toolCalls.map((toolCall) => (
        <ToolCallBlock key={toolCall.id} toolCall={toolCall} />
      ))}
      {row.diffPatch ? <diff patch={row.diffPatch} wordDiff /> : null}
    </div>
  );
}

function ToolCallBlock({
  toolCall,
}: {
  toolCall: ReturnType<typeof buildGpuixRows>[number]['toolCalls'][number];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <text style={{ color: '#f2c879' }}>{toolCall.name}</text>
      <code code={toolCall.code} language="json" />
    </div>
  );
}

export const GpuixBenchmarkApp = forwardRef<GpuixBenchmarkController>(
  function GpuixBenchmarkApp(_props, ref) {
    const [state, setState] = useState<RendererBenchmarkState>({
      fixtureKey: 'a',
      streamRevision: 0,
      inputRevision: 0,
    });
    const stateRef = useRef(state);
    const listIdRef = useRef<number | null>(null);
    const [windowStart, setWindowStart] = useState(0);
    const fixture = GPUIX_FIXTURES[state.fixtureKey];
    const rows = useMemo(
      () => buildGpuixRows(fixture, state.streamRevision),
      [fixture, state.streamRevision],
    );
    const effectiveWindowStart = Math.min(
      windowStart,
      Math.max(0, rows.length - BENCHMARK_RETAINED_WINDOW_SIZE),
    );
    const retainedRows = rows.slice(
      effectiveWindowStart,
      effectiveWindowStart + BENCHMARK_RETAINED_WINDOW_SIZE,
    );
    const updateRetainedWindow = useCallback(
      (event: EventPayload) => {
        const visibleStart = Math.max(0, Math.floor(event.startIndex ?? 0));
        const visibleEnd = Math.max(
          visibleStart + 1,
          Math.ceil(event.endIndex ?? visibleStart + 1),
        );
        setWindowStart((current) =>
          windowStartForVisibleRange({
            currentStart: current,
            itemCount: rows.length,
            windowSize: BENCHMARK_RETAINED_WINDOW_SIZE,
            buffer: BENCHMARK_WINDOW_BUFFER,
            visibleStart,
            visibleEnd,
          }),
        );
      },
      [rows.length],
    );

    const update = (updater: (current: RendererBenchmarkState) => RendererBenchmarkState) => {
      const next = updater(stateRef.current);
      stateRef.current = next;
      setState(next);
    };

    useImperativeHandle(
      ref,
      () => ({
        switchThread: () =>
          update((current) => ({
            ...current,
            fixtureKey: current.fixtureKey === 'a' ? 'b' : 'a',
          })),
        stream: () =>
          update((current) => ({
            ...current,
            streamRevision: current.streamRevision + 1,
          })),
        input: () =>
          update((current) => ({
            ...current,
            inputRevision: current.inputRevision + 1,
          })),
        snapshot: () => ({
          ...stateRef.current,
          checksum: gpuixFinalStateChecksum(GPUIX_FIXTURES, stateRef.current),
          listId: listIdRef.current,
        }),
      }),
      [],
    );

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          backgroundColor: '#0f1219',
          color: '#e7eaf0',
        }}
      >
        <div style={{ padding: 10, flexShrink: 0, backgroundColor: '#151923' }}>
          <text>{`Funny renderer benchmark · input ${state.inputRevision}`}</text>
        </div>
        <virtual-list
          ref={(instance) => {
            listIdRef.current = instance?.id ?? null;
          }}
          itemCount={rows.length}
          windowStart={effectiveWindowStart}
          onVisibleRange={updateRetainedWindow}
          overdraw={240}
          estimatedItemHeight={220}
          style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
        >
          {retainedRows.map((row) => (
            <MessageRow key={row.id} row={row} />
          ))}
        </virtual-list>
      </div>
    );
  },
);
