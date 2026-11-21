import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { AgentExecutionProfileResponse } from '@funny/shared';
import { screen } from '@testing-library/react';

import { AgentProfileIndicator } from '@/components/prompt-input/AgentProfileIndicator';
import { createDataLayer } from '@/data/data-layer';
import { getDataLayer, replaceDataLayer } from '@/data/runtime';

import { mockT } from '../../helpers/mock-i18n';
import { renderWithProviders } from '../../helpers/render';

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const PROJECT_ID = 'p1';

function seedBinding(profile: AgentExecutionProfileResponse | null) {
  getDataLayer().queryClient.setQueryData(['agent-profile-binding', PROJECT_ID], {
    projectId: PROJECT_ID,
    profile,
  });
}

const workProfile = {
  id: 'prof-1',
  name: 'Work account',
  provider: 'claude',
  config: { claude: { configDir: '~/.claude-work' } },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as AgentExecutionProfileResponse;

describe('AgentProfileIndicator', () => {
  beforeEach(() => replaceDataLayer(createDataLayer({ userId: null })));

  test("shows the project's bound profile for its provider", () => {
    seedBinding(workProfile);
    renderWithProviders(<AgentProfileIndicator projectId={PROJECT_ID} provider="claude" />);
    expect(screen.getByTestId('prompt-agent-profile').textContent).toContain('Work account');
  });

  test('hides when the selected model is from another provider', () => {
    seedBinding(workProfile);
    renderWithProviders(<AgentProfileIndicator projectId={PROJECT_ID} provider="codex" />);
    expect(screen.queryByTestId('prompt-agent-profile')).toBeNull();
  });

  test('hides when the project has no bound profile', () => {
    seedBinding(null);
    renderWithProviders(<AgentProfileIndicator projectId={PROJECT_ID} provider="claude" />);
    expect(screen.queryByTestId('prompt-agent-profile')).toBeNull();
  });
});
