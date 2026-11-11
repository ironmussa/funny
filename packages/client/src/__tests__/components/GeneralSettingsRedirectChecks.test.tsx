import { fireEvent, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { GeneralSettings } from '@/components/GeneralSettings';
import { seedProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const updateProject = vi.fn((_id: string, data: object) => okAsync({ id: 'p1', ...data }));

function renderWith(project: Record<string, unknown>) {
  seedProjects([
    { id: 'p1', name: 'Proj', path: '/repo', role: 'owner', userId: 'u1', ...project } as never,
  ]);
  useProjectStore.setState({ selectedProjectId: 'p1', updateProject: updateProject as never });
  return renderWithProviders(<GeneralSettings />);
}

const pressed = (testId: string) => screen.getByTestId(testId).getAttribute('aria-pressed');

beforeEach(() => updateProject.mockClear());

describe('GeneralSettings — run checks through funny', () => {
  test('is on when the project does not say otherwise, and saves an off', () => {
    renderWith({});
    expect(pressed('settings-redirect-checks-on')).toBe('true');
    fireEvent.click(screen.getByTestId('settings-redirect-checks-off'));
    expect(updateProject).toHaveBeenCalledWith('p1', { redirectChecks: false });
  });

  test('shows off for a project that turned it off, and saves an on', () => {
    renderWith({ redirectChecks: false });
    expect(pressed('settings-redirect-checks-off')).toBe('true');
    fireEvent.click(screen.getByTestId('settings-redirect-checks-on'));
    expect(updateProject).toHaveBeenCalledWith('p1', { redirectChecks: true });
  });
});
