import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';

import { MobilePage } from '@/components/MobilePage';

// On mobile, the project thread list must expose a way into the project's
// settings, and Back from settings must return to the thread list. This locks
// in the gear button → settings screen → back wiring in MobilePage.

vi.mock('@/hooks/use-ws', () => ({ useWS: () => {} }));

vi.mock('@/stores/app-store', () => ({
  useAppStore: (selector: (s: any) => any) =>
    selector({
      loadProjects: () => Promise.resolve(),
      projects: [{ id: 'p1', name: 'Proj' }],
    }),
}));

vi.mock('@/stores/thread-context', () => ({
  ThreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));

vi.mock('@/components/mobile/ProjectListView', () => ({
  ProjectListView: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button data-testid="select-project" onClick={() => onSelect('p1')} />
  ),
}));

vi.mock('@/components/mobile/ThreadListView', () => ({
  ThreadListView: ({ onSettings }: { onSettings: () => void }) => (
    <div data-testid="screen-threads">
      <button data-testid="open-settings" onClick={onSettings} />
    </div>
  ),
}));

vi.mock('@/components/mobile/ProjectSettingsView', () => ({
  ProjectSettingsView: ({ projectId, onBack }: { projectId: string; onBack: () => void }) => (
    <div data-testid="screen-settings" data-project={projectId}>
      <button data-testid="settings-back" onClick={onBack} />
    </div>
  ),
}));

vi.mock('@/components/mobile/SearchView', () => ({ SearchView: () => null }));
vi.mock('@/components/mobile/NewThreadView', () => ({ NewThreadView: () => null }));
vi.mock('@/components/mobile/ChatView', () => ({ ChatView: () => null }));

describe('MobilePage threads → settings → back', () => {
  test('the gear opens project settings and Back returns to the thread list', async () => {
    render(<MobilePage />);

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
