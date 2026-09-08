import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { ProjectSettingsView } from '@/components/mobile/ProjectSettingsView';
import { useProjectStore } from '@/stores/project-store';

// Mobile project settings: the list shows every project option, tapping one
// drills into its page, and Back returns to the list (not out of settings).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/stores/app-store', () => ({
  useAppStore: (selector: (s: any) => any) =>
    selector({ projects: [{ id: 'p1', name: 'Proj', role: 'owner', userId: 'u1' }] }),
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector({ user: { id: 'u1', role: 'user' } }),
}));

// Render each settings page as a marker so we can assert which one is shown,
// without pulling in Monaco / heavy panels.
vi.mock('@/components/settings/SettingsPageContent', () => ({
  SettingsPageContent: ({ page }: { page: string }) => (
    <div data-testid="settings-page-content" data-page={page} />
  ),
}));

beforeEach(() => {
  useProjectStore.setState({ selectedProjectId: null });
});

describe('ProjectSettingsView — list → detail → back', () => {
  test('points the project store at the project on mount', () => {
    render(
      <MemoryRouter>
        <ProjectSettingsView projectId="p1" onBack={() => {}} />
      </MemoryRouter>,
    );
    expect(useProjectStore.getState().selectedProjectId).toBe('p1');
  });

  test('lists project options and drills into a page, then back', () => {
    const onBack = vi.fn();
    render(
      <MemoryRouter initialEntries={['/acme/projects/p1?view=settings']}>
        <ProjectSettingsView projectId="p1" onBack={onBack} />
        <Location />
      </MemoryRouter>,
    );

    // The list shows multiple options (general, mcp-server, …). Archived
    // Threads is now a per-project view (scoped to the active project), so it
    // appears within project settings.
    expect(screen.getByTestId('mobile-settings-nav-general')).toBeTruthy();
    expect(screen.getByTestId('mobile-settings-nav-mcp-server')).toBeTruthy();
    expect(screen.getByTestId('mobile-settings-nav-archived-threads')).toBeTruthy();

    // Drill into MCP Server.
    fireEvent.click(screen.getByTestId('mobile-settings-nav-mcp-server'));
    const content = screen.getByTestId('settings-page-content');
    expect(content.getAttribute('data-page')).toBe('mcp-server');

    expect(screen.getByTestId('location').textContent).toBe(
      '/acme/projects/p1/settings/mcp-server',
    );

    // Back returns to the list — onBack (exit settings) is NOT called.
    fireEvent.click(screen.getByTestId('mobile-project-settings-page-back'));
    expect(screen.getByTestId('mobile-settings-nav-general')).toBeTruthy();
    expect(screen.queryByTestId('settings-page-content')).toBeNull();
    expect(onBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/acme/projects/p1?view=settings');

    // Back from the list exits settings.
    fireEvent.click(screen.getByTestId('mobile-project-settings-back'));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

test('opens a settings subsection directly from its URL', () => {
  render(
    <MemoryRouter initialEntries={['/projects/p1/settings/mcp-server']}>
      <ProjectSettingsView projectId="p1" onBack={() => {}} />
    </MemoryRouter>,
  );
  expect(screen.getByTestId('settings-page-content')).toHaveAttribute('data-page', 'mcp-server');
});
