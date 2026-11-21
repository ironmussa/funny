import { beforeEach, describe, expect, test, vi } from 'bun:test';

import type { Project } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { ok } from 'neverthrow';

import { GeneralSettings } from '@/components/GeneralSettings';
import { buildProject, seedProjects } from '@/data/projects/testing';
import { useProjectStore } from '@/stores/project-store';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

type UpdateProject = ReturnType<typeof useProjectStore.getState>['updateProject'];

const updateProject = vi.fn<UpdateProject>(async () => ok(buildProject({ id: 'p1' })));

function renderWith(project: Partial<Project>) {
  seedProjects([
    buildProject({
      id: 'p1',
      name: 'Proj',
      path: '/repo',
      role: 'owner',
      userId: 'u1',
      ...project,
    }),
  ]);
  useProjectStore.setState({ selectedProjectId: 'p1', updateProject });
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
