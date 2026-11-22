import { afterAll, beforeAll, describe, test, expect, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// On mobile, the project thread list must expose a way into the project's
// settings, and Back from settings must return to the thread list. This locks
// in the gear button → settings screen → back wiring in MobilePage.

mock.module('@/hooks/use-org-auto-switch', () => ({ useOrgAutoSwitch: () => {} }));

mock.module('@/hooks/use-ws', () => ({ useWS: () => {} }));

mock.module('@/stores/thread-context', () => ({
  ThreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module('@/components/ui/sonner', () => ({ Toaster: () => null }));

mock.module('@/components/mobile/ProjectListView', () => ({
  ProjectListView: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button data-testid="select-project" onClick={() => onSelect('p1')} />
  ),
}));

mock.module('@/components/mobile/ThreadListView', () => ({
  ThreadListView: ({ onSettings }: { onSettings: () => void }) => (
    <div data-testid="screen-threads">
      <button data-testid="open-settings" onClick={onSettings} />
    </div>
  ),
}));

mock.module('@/components/mobile/ProjectSettingsView', () => ({
  ProjectSettingsView: ({ projectId, onBack }: { projectId: string; onBack: () => void }) => (
    <div data-testid="screen-settings" data-project={projectId}>
      <button data-testid="settings-back" onClick={onBack} />
    </div>
  ),
}));

mock.module('@/components/mobile/SearchView', () => ({ SearchView: () => null }));
mock.module('@/components/mobile/NewThreadView', () => ({ NewThreadView: () => null }));
mock.module('@/components/mobile/ChatView', () => ({ ChatView: () => null }));

// Imported after the mocks, which bun does not hoist.
const { MobilePage } = await import('@/components/MobilePage');
const { useProjectStore } = await import('@/stores/project-store');

// MobilePage loads the project list on mount; keep that off the network.
const realLoadProjects = useProjectStore.getState().loadProjects;
beforeAll(() => useProjectStore.setState({ loadProjects: () => Promise.resolve() }));
afterAll(() => useProjectStore.setState({ loadProjects: realLoadProjects }));

describe('MobilePage threads → settings → back', () => {
  test('the gear opens project settings and Back returns to the thread list', async () => {
    render(
      <MemoryRouter>
        <MobilePage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId('select-project'));
    fireEvent.click(await screen.findByTestId('open-settings'));

    const settings = await screen.findByTestId('screen-settings');
    expect(settings.getAttribute('data-project')).toBe('p1');
    expect(screen.queryByTestId('screen-threads')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-back'));

    await waitFor(() => expect(screen.getByTestId('screen-threads')).toBeTruthy());
    expect(screen.queryByTestId('screen-settings')).toBeNull();
  });
});
