import { render, screen, fireEvent } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, test, expect, beforeEach, vi } from 'vitest';

import { PreferencesPanelBody } from '@/components/PreferencesPanel';
import { SettingsPanelBody } from '@/components/SettingsPanel';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useUIStore } from '@/stores/ui-store';

// The settings "back" button must NOT close the full-screen overlay imperatively.
// Doing so reveals the persistent ThreadView one render BEFORE the URL updates to
// the thread route, which flashes the empty new-thread compose input (ThreadView
// falls back to <NewThreadInput /> while activeThreadId is briefly null). The
// overlay must instead be closed by useViewRouteSync AFTER the URL becomes the
// thread route. These tests lock that in: clicking back navigates to the return
// path and leaves the overlay flag untouched (route-sync, not mounted here, owns
// closing it).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

let currentPath = '';
function LocationProbe() {
  const { pathname } = useLocation();
  useEffect(() => {
    currentPath = pathname;
  }, [pathname]);
  return null;
}

function renderPanel(ui: React.ReactElement, route: string) {
  currentPath = route;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TooltipProvider>
        <SidebarProvider>
          {ui}
          <LocationProbe />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useUIStore.setState({
    settingsOpen: false,
    generalSettingsOpen: false,
    settingsReturnPath: null,
    activeSettingsPage: null,
    activePreferencesPage: 'general',
  });
});

describe('settings back button — no compose flash', () => {
  test('preferences back navigates without closing the overlay imperatively', () => {
    useUIStore.setState({
      generalSettingsOpen: true,
      settingsReturnPath: '/projects/p1/threads/t1',
    });

    renderPanel(<PreferencesPanelBody />, '/preferences/general');

    fireEvent.click(screen.getByTestId('preferences-back'));

    // Route-sync (not mounted here) is what should close the overlay — only
    // after the URL is the thread route. The handler itself must leave it open.
    expect(useUIStore.getState().generalSettingsOpen).toBe(true);
    // It navigated to the saved thread route and cleared the return path.
    expect(currentPath).toBe('/projects/p1/threads/t1');
    expect(useUIStore.getState().settingsReturnPath).toBeNull();
  });

  test('settings back navigates without closing the overlay imperatively', () => {
    useUIStore.setState({
      settingsOpen: true,
      settingsReturnPath: '/projects/p1/threads/t1',
      activeSettingsPage: 'profile',
    });

    renderPanel(<SettingsPanelBody />, '/projects/p1/settings/profile');

    fireEvent.click(screen.getByTestId('settings-back'));

    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(currentPath).toBe('/projects/p1/threads/t1');
    expect(useUIStore.getState().settingsReturnPath).toBeNull();
  });
});
