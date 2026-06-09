import { render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
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

import { AvailableMcpServers, isActiveMcpServer } from '@/components/AvailableMcpServers';

function renderMcpList(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <TooltipProvider>{ui}</TooltipProvider>
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

  test('lists active MCP servers for the project', async () => {
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
    expect(screen.queryByTestId('available-mcp-disabled-one')).not.toBeInTheDocument();
    expect(screen.queryByTestId('available-mcp-needs-auth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('available-mcp-broken')).not.toBeInTheDocument();
    expect(mockListMcpServers).toHaveBeenCalledWith('/repo');
  });

  test('isActiveMcpServer excludes disabled and unhealthy servers', () => {
    expect(isActiveMcpServer({ name: 'a', type: 'stdio', status: 'ok' })).toBe(true);
    expect(isActiveMcpServer({ name: 'b', type: 'stdio', disabled: true })).toBe(false);
    expect(isActiveMcpServer({ name: 'c', type: 'stdio', status: 'needs_auth' })).toBe(false);
    expect(isActiveMcpServer({ name: 'd', type: 'stdio', status: 'error' })).toBe(false);
  });

  test('shows empty state when no active servers', async () => {
    mockListMcpServers.mockReturnValue(okAsync({ servers: [] }));

    renderMcpList(<AvailableMcpServers projectPath="/repo" />);

    await waitFor(() => {
      expect(screen.getByTestId('available-mcp-empty')).toBeInTheDocument();
    });
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
});
