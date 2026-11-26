/**
 * The factory view's Active filter, list / board / analytics switch and the
 * board's column picker (openspec factory-pipeline-board).
 */
import { BarChart3, Check, ChevronDown, KanbanSquare, List, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FilterDropdown } from '@/components/all-threads/FilterDropdown';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTooltipMenu } from '@/hooks/use-tooltip-menu';
import { FACTORY_NO_LANE, type FactoryLaneOption } from '@/lib/factory-run-labels';
import { cn } from '@/lib/utils';
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

/** With more options than this, the lane filter's menu gets a search field. */
const LANE_SEARCH_MIN_OPTIONS = 8;

/**
 * The factory view's lane filter (openspec factory-lanes D10): one option per
 * project and lane, from the factories' lanes and the loaded runs. Hidden only
 * when there is no lane at all and none is selected.
 */
export function FactoryLaneFilter({
  lanes,
  selected,
  onToggle,
  counts,
}: {
  /** From `factoryLaneOptions`, sorted. */
  lanes: readonly FactoryLaneOption[];
  selected: Set<string>;
  onToggle: (lane: string) => void;
  counts: Record<string, number>;
}) {
  const { t } = useTranslation();
  if (lanes.length === 0 && selected.size === 0) return null;
  const options = [...lanes, { value: FACTORY_NO_LANE, label: t('factoryView.noLane', 'No lane') }];
  return (
    <FilterDropdown
      testId="factory-view-lane-filter"
      label={t('factoryView.filterLane', 'Lane')}
      options={options}
      selected={selected}
      onToggle={onToggle}
      counts={counts}
      search={
        lanes.length > LANE_SEARCH_MIN_OPTIONS
          ? { placeholder: t('factoryView.searchLanes', 'Search lanes') }
          : undefined
      }
    />
  );
}

/**
 * All runs or only the ones that have not ended, as a single-choice dropdown
 * styled like the view's other filters.
 */
export function FactoryActiveToggle({
  activeOnly,
  onChange,
}: {
  activeOnly: boolean;
  onChange: (activeOnly: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const options = [
    {
      value: false,
      testId: 'factory-view-show-all',
      label: t('factoryView.showAll', 'All'),
      detail: t('factoryView.showAllTooltip', 'Show every run, ended ones too'),
    },
    {
      value: true,
      testId: 'factory-view-show-active',
      label: t('factoryView.showActive', 'Active'),
      detail: t('factoryView.showActiveTooltip', 'Show only the runs that have not ended'),
    },
  ];
  const current = options.find((option) => option.value === activeOnly) ?? options[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="factory-view-active-filter"
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
            activeOnly
              ? 'bg-accent text-accent-foreground border-accent-foreground/20'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
          )}
        >
          {t('factoryView.runsFilter', 'Runs')}: {current.label}
          <ChevronDown className="icon-xs opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" padding="xs" className="w-64">
        <div role="menu">
          {options.map((option) => {
            const checked = option.value === activeOnly;
            return (
              <button
                key={option.testId}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                data-testid={option.testId}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none',
                  'hover:bg-accent focus-visible:bg-accent',
                )}
              >
                <Check className={cn('icon-xs mt-0.5 shrink-0', !checked && 'invisible')} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{option.label}</span>
                  <span className="text-muted-foreground text-2xs">{option.detail}</span>
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
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
      size="sm"
      variant="outline"
      value={[layout]}
      onValueChange={([value]) => {
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
