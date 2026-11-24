import { afterEach, describe, expect, test } from 'bun:test';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { AgentActionEffects } from '@/components/browser-panel/AgentActionEffects';
import { dispatchBrowserSessionEvent } from '@/hooks/dispatch-browser-session-events';
import { useBrowserPointerStore } from '@/stores/browser-pointer-store';

const viewport = { width: 1000, height: 500 };

// jsdom's style has no unprefixed `animation`, so React listens for the
// WebKit-prefixed name there.
const endAnimation = (el: HTMLElement) =>
  fireEvent(el, new Event('webkitAnimationEnd', { bubbles: true }));

afterEach(() => act(() => useBrowserPointerStore.setState({ actionBySession: {} })));

describe('AgentActionEffects', () => {
  test('draws nothing until the agent acts', () => {
    render(<AgentActionEffects sessionId="s1" viewport={viewport} />);
    expect(screen.queryByTestId('browser-agent-action')).not.toBeInTheDocument();
  });

  test('a pressed key shows the key and a label by the cursor', async () => {
    render(<AgentActionEffects sessionId="s1" viewport={viewport} />);
    act(() =>
      dispatchBrowserSessionEvent('browser-session:agent-action', {
        sessionId: 's1',
        kind: 'press',
        x: 250,
        y: 400,
        detail: 'Enter',
      }),
    );
    expect(await screen.findByTestId('browser-agent-action-key')).toHaveTextContent('Enter');
    const label = screen.getByTestId('browser-agent-action-label');
    expect(label.style.getPropertyValue('--agent-action-left')).toBe('25%');
    expect(label.style.getPropertyValue('--agent-action-top')).toBe('80%');
    expect(label).toHaveClass('left-[var(--agent-action-left)]', 'top-[var(--agent-action-top)]');
  });

  test('a screenshot flashes the page once', async () => {
    render(<AgentActionEffects sessionId="s1" viewport={viewport} />);
    const shoot = () =>
      act(() => useBrowserPointerStore.getState().setAction('s1', { kind: 'screenshot' }));
    shoot();
    endAnimation(await screen.findByTestId('browser-agent-action-flash'));
    expect(screen.queryByTestId('browser-agent-action')).not.toBeInTheDocument();
    // A second screenshot flashes again.
    shoot();
    expect(screen.getByTestId('browser-agent-action-flash')).toBeInTheDocument();
  });

  test('a drag draws its trail from start to end', () => {
    render(<AgentActionEffects sessionId="s1" viewport={viewport} />);
    act(() =>
      useBrowserPointerStore
        .getState()
        .setAction('s1', { kind: 'drag', x: 10, y: 20, toX: 110, toY: 120 }),
    );
    const line = screen.getByTestId('browser-agent-action-drag').querySelector('line');
    expect(line?.getAttribute('x1')).toBe('10');
    expect(line?.getAttribute('y2')).toBe('120');
  });

  test('ignores actions of other sessions', () => {
    render(<AgentActionEffects sessionId="s1" viewport={viewport} />);
    act(() => useBrowserPointerStore.getState().setAction('s2', { kind: 'click', x: 1, y: 1 }));
    expect(screen.queryByTestId('browser-agent-action')).not.toBeInTheDocument();
  });
});
