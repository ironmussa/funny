import { describe, test, expect, vi, beforeEach, mock } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { ProjectSettingsView } from '@/components/mobile/ProjectSettingsView';
import { buildProject, seedProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

// Mobile project settings: the list shows every project option, tapping one
// drills into its page, and Back returns to the list (not out of settings).

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

mock.module('@/stores/auth-store', () => ({
  useAuthStore: (selector: (s: any) => any) => selector({ user: { id: 'u1', role: 'user' } }),
}));

// Render each settings page as a marker so we can assert which one is shown,
// without pulling in Monaco / heavy panels.
mock.module('@/components/settings/SettingsPageContent', () => ({
  SettingsPageContent: ({ page }: { page: string }) => (
    <div data-testid="settings-page-content" data-page={page} />
  ),
}));

beforeEach(() => {
  seedProjects([buildProject({ id: 'p1', name: 'Proj', role: 'owner', userId: 'u1' })]);
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
    expect(onBack).toHaveBeenCalledTimes(1);
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
