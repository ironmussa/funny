import type { Automation } from '@funny/shared';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { seedAutomations } from '@/data/automations/testing';
import { useAppStore } from '@/stores/app-store';

import { AutomationSettings } from './AutomationSettings';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="max-w-4xl p-6">{children}</div>
    </MemoryRouter>
  );
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    projectId: 'proj-1',
    userId: 'user-1',
    name: 'Daily Issue Triage',
    prompt: 'Review all open issues and label them by priority',
    schedule: '0 9 * * *',
    provider: 'claude',
    model: 'sonnet',
    mode: 'local',
    permissionMode: 'autoEdit',
    maxRunHistory: 10,
    enabled: true,
    lastRunAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
    ...overrides,
  };
}

function seedStores({ automations = [] as Automation[] } = {}) {
  useAppStore.setState({ selectedProjectId: 'proj-1' });
  seedAutomations({ automations });
}

const meta = {
  title: 'Settings/AutomationSettings',
  component: AutomationSettings,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof AutomationSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty state — no automations created yet. */
export const Empty: Story = {
  render: () => {
    seedStores({ automations: [] });
    return (
      <Wrapper>
        <AutomationSettings />
      </Wrapper>
    );
  },
};

/** Multiple automations with mixed enabled/disabled states. */
export const WithAutomations: Story = {
  render: () => {
    seedStores({
      automations: [
        makeAutomation({
          id: 'auto-1',
          name: 'Daily Issue Triage',
          schedule: '0 9 * * *',
          enabled: true,
        }),
        makeAutomation({
          id: 'auto-2',
          name: 'Weekly Dependency Check',
          prompt: 'Check for outdated dependencies and create upgrade PRs',
          schedule: '0 9 * * 1',
          model: 'haiku',
          enabled: false,
          lastRunAt: undefined,
        }),
        makeAutomation({
          id: 'auto-3',
          name: 'Hourly Health Check',
          prompt: 'Run test suite and report failures',
          schedule: '0 * * * *',
          model: 'opus',
          enabled: true,
          lastRunAt: new Date(Date.now() - 30 * 60_000).toISOString(),
        }),
      ],
    });
    return (
      <Wrapper>
        <AutomationSettings />
      </Wrapper>
    );
  },
};

/** No project selected — shows message to select a project. */
export const NoProject: Story = {
  render: () => {
    useAppStore.setState({ selectedProjectId: null });
    seedAutomations({});
    return (
      <Wrapper>
        <AutomationSettings />
      </Wrapper>
    );
  },
};
