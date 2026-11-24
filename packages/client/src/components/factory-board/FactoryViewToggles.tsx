/** The factory view's Active filter and list / board / analytics switch (openspec factory-pipeline-board). */
import { BarChart3, KanbanSquare, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { FactoryViewLayout } from '@/stores/factory-view-store';

export function FactoryActiveToggle({
  activeOnly,
  onChange,
}: {
  activeOnly: boolean;
  onChange: (activeOnly: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={activeOnly ? 'active' : 'all'}
      onValueChange={(value) => value && onChange(value === 'active')}
    >
      <ToggleGroupItem value="all" data-testid="factory-view-show-all">
        {t('factoryView.showAll', 'All')}
      </ToggleGroupItem>
      <ToggleGroupItem value="active" data-testid="factory-view-show-active">
        {t('factoryView.showActive', 'Active')}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function FactoryLayoutToggle({
  layout,
  onChange,
}: {
  layout: FactoryViewLayout;
  onChange: (layout: FactoryViewLayout) => void;
}) {
  const { t } = useTranslation();
  const list = t('factoryView.layoutList', 'List');
  const board = t('factoryView.layoutBoard', 'Board');
  const analytics = t('factoryView.layoutAnalytics', 'Analytics');
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={layout}
      onValueChange={(value) => {
        if (value === 'list' || value === 'board' || value === 'analytics') onChange(value);
      }}
    >
      <ToggleGroupItem
        value="list"
        aria-label={list}
        title={list}
        data-testid="factory-view-layout-list"
      >
        <List className="icon-sm" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="board"
        aria-label={board}
        title={board}
        data-testid="factory-view-layout-board"
      >
        <KanbanSquare className="icon-sm" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="analytics"
        aria-label={analytics}
        title={analytics}
        data-testid="factory-view-layout-analytics"
      >
        <BarChart3 className="icon-sm" />
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
