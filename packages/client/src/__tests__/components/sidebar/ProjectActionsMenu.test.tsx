import { describe, expect, mock, test, vi } from 'bun:test';

import { act, screen } from '@testing-library/react';

import { ProjectActionsMenu } from '@/components/sidebar/ProjectActionsMenu';
import { buildProject } from '@/data/projects/testing';

import { mockT } from '../../helpers/mock-i18n';
import { renderWithProviders } from '../../helpers/render';

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ProjectActionsMenu', () => {
  test('the more-actions menu is reachable by keyboard and labelled', () => {
    renderWithProviders(
      <ProjectActionsMenu
        project={buildProject({ id: 'p1', name: 'Demo' })}
        onRenameProject={vi.fn()}
        onDeleteProject={vi.fn()}
      />,
    );

    const more = screen.getByTestId('project-more-actions-p1');
    expect(more).not.toHaveAttribute('tabindex', '-1');
    expect(more).toHaveAccessibleName('Project actions');
    act(() => more.focus());
    expect(more).toHaveFocus();
    // The hover-only wrapper must also reveal the trigger while it holds focus.
    expect(more.parentElement?.className).toContain('focus-within:opacity-100');
  });
});
