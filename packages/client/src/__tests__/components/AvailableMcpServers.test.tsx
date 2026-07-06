import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ok, okAsync } from 'neverthrow';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { mockT } from '../helpers/mock-i18n';

const mockListMcpServers = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/lib/api', () => ({
  api: {
    listMcpServers: mockListMcpServers,
  },
}));

import { isActiveMcpServer, isVisibleMcpServer } from '@/components/available-mcp-servers-utils';
import { AvailableMcpServers } from '@/components/AvailableMcpServers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type IdleDeadlineStub = { didTimeout: boolean; timeRemaining: () => number };

function renderMcpList(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </MemoryRouter>,
  );
}

describe('AvailableMcpServers', () => {
  beforeEach(() => {
    mockListMcpServers.mockReset();
  });

  test('renders nothing without project path', () => {
    const { container } = renderMcpList(<AvailableMcpServers />);
    expect(container).toBeEmptyDOMElement();
  });

  test('lists usable and auth-blocked MCP servers for the project', async () => {
    mockListMcpServers.mockReturnValue(
      okAsync({
        servers: [
          { name: 'github', type: 'stdio', disabled: false, status: 'ok' },
          { name: 'disabled-one', type: 'http', disabled: true },
          { name: 'needs-auth', type: 'http', disabled: false, status: 'needs_auth' },
          { name: 'broken', type: 'stdio', disabled: false, status: 'error' },
        ],
      }),
    );

    renderMcpList(<AvailableMcpServers projectPath="/repo" />);

    await waitFor(() => {
      expect(screen.getByTestId('available-mcp-github')).toBeInTheDocument();
    });
    expect(screen.getByTestId('available-mcp-needs-auth')).toHaveAttribute(
      'aria-label',
      'needs-auth: mcp.needsAuth',
    );
    expect(screen.queryByTestId('available-mcp-disabled-one')).not.toBeInTheDocument();
    expect(screen.queryByTestId('available-mcp-broken')).not.toBeInTheDocument();
    expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'claude', undefined);
  });

  test('labels MCP tooltip details and only applies warning color to auth issues', async () => {
    mockListMcpServers.mockReturnValue(
      okAsync({
        servers: [
          {
            name: 'healthy-http',
            type: 'http',
            url: 'https://mcp.example.test/mcp',
            source: 'project',
            disabled: false,
            status: 'ok',
          },
          {
            name: 'linear-server',
            type: 'http',
            url: 'https://mcp.linear.app/mcp',
            source: 'user',
            disabled: false,
            status: 'needs_auth',
          },
        ],
      }),
    );

    renderMcpList(<AvailableMcpServers projectPath="/repo" />);

    const healthyBadge = await screen.findByTestId('available-mcp-healthy-http');
    expect(healthyBadge).not.toHaveClass(
      'border-amber-500/50',
      'bg-amber-500/10',
      'text-amber-300',
    );

    const badge = await screen.findByTestId('available-mcp-linear-server');
    expect(badge).toHaveClass('border-amber-500/50', 'bg-amber-500/10', 'text-amber-300');

    fireEvent.pointerMove(badge);
    fireEvent.focus(badge);

    await waitFor(() => {
      expect(screen.getAllByText('Transport').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Remote HTTP').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Scope').length).toBeGreaterThan(0);
    expect(screen.getAllByText('User').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Endpoint').length).toBeGreaterThan(0);
    expect(screen.getAllByText('https://mcp.linear.app/mcp').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Status').length).toBeGreaterThan(0);
    expect(screen.getAllByText('mcp.needsAuth').length).toBeGreaterThan(0);
  });

  test('isActiveMcpServer excludes disabled and unhealthy servers', () => {
    expect(isActiveMcpServer({ name: 'a', type: 'stdio', status: 'ok' })).toBe(true);
    expect(isActiveMcpServer({ name: 'b', type: 'stdio', disabled: true })).toBe(false);
    expect(isActiveMcpServer({ name: 'c', type: 'stdio', status: 'needs_auth' })).toBe(false);
    expect(isActiveMcpServer({ name: 'd', type: 'stdio', status: 'error' })).toBe(false);
  });

  test('isVisibleMcpServer includes auth-blocked servers', () => {
    expect(isVisibleMcpServer({ name: 'a', type: 'stdio', status: 'ok' })).toBe(true);
    expect(isVisibleMcpServer({ name: 'b', type: 'stdio', disabled: true })).toBe(false);
    expect(isVisibleMcpServer({ name: 'c', type: 'stdio', status: 'needs_auth' })).toBe(true);
    expect(isVisibleMcpServer({ name: 'd', type: 'stdio', status: 'error' })).toBe(false);
  });

  test('shows empty state when no visible servers', async () => {
    mockListMcpServers.mockReturnValue(okAsync({ servers: [] }));

    renderMcpList(<AvailableMcpServers projectPath="/repo" />);

    await waitFor(() => {
      expect(screen.getByTestId('available-mcp-empty')).toBeInTheDocument();
    });
  });

  test('uses the compact loading spinner size', async () => {
    mockListMcpServers.mockReturnValue(new Promise(() => {}));

    renderMcpList(<AvailableMcpServers projectPath="/repo" />);

    const spinner = await screen.findByTestId('available-mcp-loading');
    expect(spinner).toHaveClass('icon-xs', 'animate-spin');
  });

  test('still loads after StrictMode cancels the initial idle callback', async () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const idleCallbacks = new Map<number, (deadline: IdleDeadlineStub) => void>();
    const canceled = new Set<number>();
    let nextIdleId = 1;
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((cb) => {
        const id = nextIdleId++;
        idleCallbacks.set(id, cb as (deadline: IdleDeadlineStub) => void);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelIdleCallback',
      vi.fn((id) => {
        canceled.add(id as number);
      }),
    );
    mockListMcpServers.mockReturnValue(
      okAsync({ servers: [{ name: 'github', type: 'stdio', status: 'ok' }] }),
    );

    try {
      renderMcpList(
        <StrictMode>
          <AvailableMcpServers projectPath="/repo" provider="codex" projectId="p1" />
        </StrictMode>,
      );

      await act(async () => {
        for (const [id, cb] of idleCallbacks) {
          if (!canceled.has(id)) cb({ didTimeout: false, timeRemaining: () => 50 });
        }
      });

      expect(await screen.findByTestId('available-mcp-github')).toBeInTheDocument();
      expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'codex', 'p1');
    } finally {
      if (originalRequestIdleCallback) {
        vi.stubGlobal('requestIdleCallback', originalRequestIdleCallback);
      } else {
        Reflect.deleteProperty(globalThis, 'requestIdleCallback');
      }
      if (originalCancelIdleCallback) {
        vi.stubGlobal('cancelIdleCallback', originalCancelIdleCallback);
      } else {
        Reflect.deleteProperty(globalThis, 'cancelIdleCallback');
      }
    }
  });

  test('title links to project MCP settings', async () => {
    mockListMcpServers.mockReturnValue(okAsync({ servers: [] }));

    renderMcpList(<AvailableMcpServers projectPath="/repo" projectId="proj-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('available-mcp-settings-link')).toBeInTheDocument();
    });
    expect(screen.getByTestId('available-mcp-settings-link')).toHaveAttribute(
      'href',
      '/projects/proj-1/settings/mcp-server',
    );
  });

  test('loads servers for the selected provider', async () => {
    mockListMcpServers.mockReturnValue(okAsync({ servers: [] }));

    renderMcpList(<AvailableMcpServers projectPath="/repo" provider="codex" />);

    await waitFor(() => {
      expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'codex', undefined);
    });
  });

  test('ignores stale MCP loads after the selected provider changes', async () => {
    const originalRequestIdleCallback = globalThis.requestIdleCallback;
    const originalCancelIdleCallback = globalThis.cancelIdleCallback;
    const idleCallbacks: Array<(deadline: IdleDeadlineStub) => void> = [];
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((cb) => {
        idleCallbacks.push(cb as (deadline: IdleDeadlineStub) => void);
        return idleCallbacks.length;
      }),
    );
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const claudeLoad = deferred<any>();
    const codexLoad = deferred<any>();
    mockListMcpServers.mockImplementation((_projectPath, provider) =>
      provider === 'claude' ? claudeLoad.promise : codexLoad.promise,
    );

    const view = renderMcpList(<AvailableMcpServers projectPath="/repo" provider="claude" />);

    await act(async () => {
      idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 50 });
    });
    expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'claude', undefined);

    view.rerender(
      <MemoryRouter>
        <TooltipProvider delayDuration={0}>
          <AvailableMcpServers projectPath="/repo" provider="codex" />
        </TooltipProvider>
      </MemoryRouter>,
    );

    await act(async () => {
      idleCallbacks.shift()?.({ didTimeout: false, timeRemaining: () => 50 });
    });
    expect(mockListMcpServers).toHaveBeenCalledWith('/repo', 'codex', undefined);

    await act(async () => {
      codexLoad.resolve(ok({ servers: [{ name: 'codex-mcp', type: 'stdio' }] }));
      await Promise.resolve();
    });
    expect(await screen.findByTestId('available-mcp-codex-mcp')).toBeInTheDocument();

    await act(async () => {
      claudeLoad.resolve(ok({ servers: [{ name: 'claude-mcp', type: 'stdio' }] }));
      await Promise.resolve();
    });

    expect(screen.getByTestId('available-mcp-codex-mcp')).toBeInTheDocument();
    expect(screen.queryByTestId('available-mcp-claude-mcp')).not.toBeInTheDocument();
    if (originalRequestIdleCallback) {
      vi.stubGlobal('requestIdleCallback', originalRequestIdleCallback);
    } else {
      Reflect.deleteProperty(globalThis, 'requestIdleCallback');
    }
    if (originalCancelIdleCallback) {
      vi.stubGlobal('cancelIdleCallback', originalCancelIdleCallback);
    } else {
      Reflect.deleteProperty(globalThis, 'cancelIdleCallback');
    }
  });
});
