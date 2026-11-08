import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { AgentPointer } from '@/components/browser-panel/AgentPointer';
import { dispatchBrowserSessionEvent } from '@/hooks/dispatch-browser-session-events';
import { useBrowserPointerStore } from '@/stores/browser-pointer-store';

const viewport = { width: 1000, height: 500 };

afterEach(() => useBrowserPointerStore.setState({ bySession: {} }));

describe('AgentPointer', () => {
  test('draws nothing until the agent moves the mouse', () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    expect(screen.queryByTestId('browser-agent-pointer')).not.toBeInTheDocument();
  });

  test('a pointer event places the cursor in percent of the page viewport', async () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    dispatchBrowserSessionEvent('browser-session:pointer', {
      sessionId: 's1',
      x: 250,
      y: 400,
      kind: 'click',
    });
    const pointer = await screen.findByTestId('browser-agent-pointer');
    expect(pointer.style.left).toBe('25%');
    expect(pointer.style.top).toBe('80%');
    expect(pointer).toHaveAttribute('data-pointer-kind', 'click');
  });

  test('ignores pointer events of other sessions', () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    act(() => useBrowserPointerStore.getState().setPointer('s2', { x: 1, y: 1, kind: 'move' }));
    expect(screen.queryByTestId('browser-agent-pointer')).not.toBeInTheDocument();
  });
});
