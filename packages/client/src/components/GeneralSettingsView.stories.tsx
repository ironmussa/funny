import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { useSettingsStore } from '@/stores/settings-store';
import { useUIStore } from '@/stores/ui-store';

import { GeneralSettingsView } from './GeneralSettingsView';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <div className="flex h-[700px] w-[800px] overflow-hidden rounded-lg border border-border">
        {children}
      </div>
    </MemoryRouter>
  );
}

function seedStores({ activePreferencesPage = 'general' as string } = {}) {
  useSettingsStore.setState({
    defaultEditor: 'vscode',
    useInternalEditor: true,
    terminalShell: 'default',
    availableShells: [
      { id: 'bash', label: 'Bash', path: '/bin/bash' },
      { id: 'zsh', label: 'Zsh', path: '/bin/zsh' },
      { id: 'fish', label: 'Fish', path: '/usr/bin/fish' },
    ],
    _shellsLoaded: true,
  });
  useUIStore.setState({
    generalSettingsOpen: true,
    activePreferencesPage,
  });
}

const meta = {
  title: 'Settings/GeneralSettingsView',
  component: GeneralSettingsView,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof GeneralSettingsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** General preferences — editor, language, shell. */
export const GeneralPage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'general' });
    return (
      <Wrapper>
        <GeneralSettingsView />
      </Wrapper>
    );
  },
};

/** Appearance page — theme picker grid. */
export const AppearancePage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'appearance' });
    return (
      <Wrapper>
        <GeneralSettingsView />
      </Wrapper>
    );
  },
};

/** GitHub token settings page. */
export const GitHubPage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'github' });
    return (
      <Wrapper>
        <GeneralSettingsView />
      </Wrapper>
    );
  },
};

/** Speech (AssemblyAI) settings page. */
export const SpeechPage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'speech' });
    return (
      <Wrapper>
        <GeneralSettingsView />
      </Wrapper>
    );
  },
};

/** Email (SMTP) settings page. */
export const EmailPage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'email' });
    return (
      <Wrapper>
        <GeneralSettingsView />
      </Wrapper>
    );
  },
};
