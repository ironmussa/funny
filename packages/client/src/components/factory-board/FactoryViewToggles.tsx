/**
 * The factory view's Active filter, list / board / analytics switch and the
 * board's column picker (openspec factory-pipeline-board).
 */
import { BarChart3, KanbanSquare, List, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { type FactoryViewLayout, useFactoryViewStore } from '@/stores/factory-view-store';

import { FACTORY_BOARD_COLUMNS } from './board-columns';
import { useFactoryBoardColumnTitles } from './FactoryBoard';

/** Shows or hides the board's columns; the choice is kept across visits. */
export function FactoryBoardColumnsMenu() {
  const { t } = useTranslation();
  const titles = useFactoryBoardColumnTitles();
  const hidden = useFactoryViewStore((state) => state.hiddenColumns);
  const setColumnHidden = useFactoryViewStore((state) => state.setColumnHidden);
  const showAllColumns = useFactoryViewStore((state) => state.showAllColumns);
  const label = t('factoryView.columns', 'Columns');
  const shownCount = FACTORY_BOARD_COLUMNS.length - hidden.length;
  const menu = useTooltipMenu();
  return (
    <DropdownMenu {...menu.menuProps}>
      <Tooltip {...menu.tooltipProps}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              data-testid="factory-board-columns-menu"
            >
              <SlidersHorizontal className="icon-sm" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('factoryView.columnsTooltip', 'Show or hide columns')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {FACTORY_BOARD_COLUMNS.map((id) => {
          const shown = !hidden.includes(id);
          return (
            <DropdownMenuCheckboxItem
              key={id}
              checked={shown}
              // Keep at least one column on the board.
              disabled={shown && shownCount <= 1}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => setColumnHidden(id, !checked)}
              data-testid={`factory-board-columns-toggle-${id}`}
            >
              {titles[id]}
            </DropdownMenuCheckboxItem>
          );
        })}
        {hidden.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={showAllColumns}
              data-testid="factory-board-columns-show-all"
            >
              {t('factoryView.showAllColumns', 'Show all columns')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="all" data-testid="factory-view-show-all">
            {t('factoryView.showAll', 'All')}
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>
          {t('factoryView.showAllTooltip', 'Show every run, ended ones too')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="active" data-testid="factory-view-show-active">
            {t('factoryView.showActive', 'Active')}
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>
          {t('factoryView.showActiveTooltip', 'Show only the runs that have not ended')}
        </TooltipContent>
      </Tooltip>
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
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="list" aria-label={list} data-testid="factory-view-layout-list">
            <List className="icon-sm" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>{list}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem value="board" aria-label={board} data-testid="factory-view-layout-board">
            <KanbanSquare className="icon-sm" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>{board}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <ToggleGroupItem
            value="analytics"
            aria-label={analytics}
            data-testid="factory-view-layout-analytics"
          >
            <BarChart3 className="icon-sm" />
          </ToggleGroupItem>
        </TooltipTrigger>
        <TooltipContent>{analytics}</TooltipContent>
      </Tooltip>
    </ToggleGroup>
  );
}
