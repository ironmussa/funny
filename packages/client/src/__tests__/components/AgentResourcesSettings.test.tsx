import type { AgentResource } from '@funny/shared';
import { render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { mockT } from '../helpers/mock-i18n';

const mockListAgentResources = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/lib/api', () => ({
  api: { listAgentResources: mockListAgentResources },
}));

vi.mock('@/stores/app-store', () => ({
  useAppStore: (sel: (s: unknown) => unknown) =>
    sel({ projects: [{ id: 'p1', path: '/repo' }], selectedProjectId: 'p1' }),
}));

import { AgentResourcesSettings } from '@/components/AgentResourcesSettings';

const claudeSkill: AgentResource = {
  kind: 'skill',
  name: 'skill-creator',
  origin: 'claude-global',
  compatibleProviders: ['claude'],
  usable: true,
};
const incompatible: AgentResource = {
  kind: 'skill',
  name: 'codex-only-thing',
  origin: 'claude-global',
  compatibleProviders: ['claude'],
  usable: false,
  hiddenReason: 'provider_mismatch',
};

describe('AgentResourcesSettings', () => {
  beforeEach(() => {
    mockListAgentResources.mockReset();
  });

  test('renders usable resources and lists incompatible ones for audit', async () => {
    mockListAgentResources.mockReturnValue(
      okAsync({ provider: 'claude', resources: [claudeSkill], hidden: [incompatible] }),
    );

    render(<AgentResourcesSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-resource-skill-skill-creator')).toBeInTheDocument();
    });
    // incompatible resources are shown only under the audit section
    expect(screen.getByTestId('agent-resources-incompatible')).toBeInTheDocument();
    expect(screen.getByTestId('agent-resource-skill-codex-only-thing')).toBeInTheDocument();
  });

  test('requests resources in the settings phase', async () => {
    mockListAgentResources.mockReturnValue(
      okAsync({ provider: 'claude', resources: [], hidden: [] }),
    );

    render(<AgentResourcesSettings />);

    await waitFor(() => {
      expect(mockListAgentResources).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'claude', phase: 'settings', projectPath: '/repo' }),
      );
    });
  });
});
