import type { Meta, StoryObj } from '@storybook/react-vite';
import { Palette, SlidersHorizontal, Webhook } from 'lucide-react';

import '@/i18n/config';
import { SidebarContent, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';

import { SettingsNavFilter } from './SettingsNavFilter';
import type { SettingsNavPage } from './use-settings-filter';

const PAGES: SettingsNavPage[] = [
  { id: 'general', label: 'General', labelEn: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', labelEn: 'Appearance', icon: Palette },
];

const PROJECT_PAGES: SettingsNavPage[] = [
  { id: 'hooks', label: 'Hooks', labelEn: 'Hooks', icon: Webhook },
];

/** Seeds the shared filter text before the story renders. */
function seedQuery(query: string) {
  useSettingsFilterStore.setState({ query, focusId: null });
}

function Frame({ withOther = false }: { withOther?: boolean }) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <div className="bg-sidebar flex h-screen w-[260px] flex-col py-3">
          <SidebarContent inset="list">
            <SettingsNavFilter
              scope="preferences"
              pages={PAGES}
              activePageId="general"
              openPage={() => {}}
              testIdPrefix="preferences"
              other={
                withOther ? { scope: 'project', pages: PROJECT_PAGES, openPage: () => {} } : null
              }
            />
          </SidebarContent>
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}

const meta = {
  title: 'Settings/SettingsNavFilter',
  component: Frame,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No filter: the plain page list. */
export const Empty: Story = {
  render: () => {
    seedQuery('');
    return <Frame />;
  },
};

/** "font" matches a setting inside Appearance. */
export const Results: Story = {
  render: () => {
    seedQuery('font');
    return <Frame />;
  },
};

/** Nothing matches. */
export const NoResults: Story = {
  render: () => {
    seedQuery('zzz-no-such-setting');
    return <Frame />;
  },
};

/** Only the other surface (Project Settings) has a match. */
export const CrossSurfaceHint: Story = {
  render: () => {
    seedQuery('hooks');
    return <Frame withOther />;
  },
};
