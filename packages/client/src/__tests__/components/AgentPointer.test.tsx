import { afterEach, describe, expect, test, setDefaultTimeout } from 'bun:test';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { AgentPointer } from '@/components/browser-panel/AgentPointer';
import { dispatchBrowserSessionEvent } from '@/hooks/dispatch-browser-session-events';
import { useBrowserPointerStore } from '@/stores/browser-pointer-store';

// The proof and pre-push run these files together under `bun test --parallel`; on a
// loaded machine a first render (cold module load) ran well past the 5 s default.
setDefaultTimeout(60_000);

const viewport = { width: 1000, height: 500 };

// The pointer is still mounted here (cleanup runs after this hook).
afterEach(() => act(() => useBrowserPointerStore.setState({ bySession: {} })));

describe('AgentPointer', () => {
  test('draws nothing until the agent moves the mouse', () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    expect(screen.queryByTestId('browser-agent-pointer')).not.toBeInTheDocument();
  });

  test('a pointer event places the cursor in percent of the page viewport', async () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    act(() =>
      dispatchBrowserSessionEvent('browser-session:pointer', {
        sessionId: 's1',
        x: 250,
        y: 400,
        kind: 'click',
      }),
    );
    const pointer = await screen.findByTestId('browser-agent-pointer');
    expect(pointer.style.getPropertyValue('--agent-pointer-left')).toBe('25%');
    expect(pointer.style.getPropertyValue('--agent-pointer-top')).toBe('80%');
    expect(pointer).toHaveClass(
      'left-[var(--agent-pointer-left)]',
      'top-[var(--agent-pointer-top)]',
    );
    expect(pointer).toHaveAttribute('data-pointer-kind', 'click');
  });

  test('ignores pointer events of other sessions', () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    act(() => useBrowserPointerStore.getState().setPointer('s2', { x: 1, y: 1, kind: 'move' }));
    expect(screen.queryByTestId('browser-agent-pointer')).not.toBeInTheDocument();
  });

  test('the click pulse plays once and then goes away', async () => {
    render(<AgentPointer sessionId="s1" viewport={viewport} />);
    const click = () =>
      act(() => useBrowserPointerStore.getState().setPointer('s1', { x: 5, y: 5, kind: 'click' }));
    click();
    const pulse = await screen.findByTestId('browser-agent-pointer-pulse');
    // jsdom's style has no unprefixed `animation`, so React listens for the
    // WebKit-prefixed name there.
    fireEvent(pulse, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(screen.queryByTestId('browser-agent-pointer-pulse')).not.toBeInTheDocument();
    // A second click on the same spot pulses again.
    click();
    expect(screen.getByTestId('browser-agent-pointer-pulse')).toBeInTheDocument();
  });
});
