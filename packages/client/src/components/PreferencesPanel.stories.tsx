import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';

import '@/i18n/config';
import { SidebarProvider } from '@/components/ui/sidebar';
import { useUIStore } from '@/stores/ui-store';

import { PreferencesPanel } from './PreferencesPanel';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter>
      <SidebarProvider>
        <div className="flex h-screen w-[240px] overflow-hidden">{children}</div>
      </SidebarProvider>
    </MemoryRouter>
  );
}

function seedStores({ activePreferencesPage = 'general' as string } = {}) {
  useUIStore.setState({
    generalSettingsOpen: true,
    activePreferencesPage,
  });
}

const meta = {
  title: 'Settings/PreferencesPanel',
  component: PreferencesPanel,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof PreferencesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GeneralPage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'general' });
    return (
      <Wrapper>
        <PreferencesPanel />
      </Wrapper>
    );
  },
};

export const AppearancePage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'appearance' });
    return (
      <Wrapper>
        <PreferencesPanel />
      </Wrapper>
    );
  },
};

export const GitHubPage: Story = {
  render: () => {
    seedStores({ activePreferencesPage: 'github' });
    return (
      <Wrapper>
        <PreferencesPanel />
      </Wrapper>
    );
  },
};
