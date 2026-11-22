import { ArrowRight, Search } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';

import {
  countSettingsResults,
  filterSettings,
  normalizeSettingsQuery,
  type FilterPageResult,
} from './settings-filter';
import type { SettingId, SettingsScope } from './settings-index';
import { useSettingsTranslators, type SettingsNavPage } from './use-settings-filter';

export interface OtherSettingsSurface {
  scope: SettingsScope;
  pages: readonly SettingsNavPage[];
  /** Opens a page of the other surface. */
  openPage: (pageId: string) => void;
}

interface Props {
  scope: SettingsScope;
  /** Pages this user can open, in sidebar order (already gated). */
  pages: readonly SettingsNavPage[];
  activePageId: string | null;
  openPage: (pageId: string) => void;
  /** `data-testid` prefix of the page buttons (`preferences` / `settings`). */
  testIdPrefix: string;
  /** The other settings surface, for the cross-surface hint; null = no hint. */
  other: OtherSettingsSurface | null;
}

type FlatResult = { pageId: string; elementId: SettingId | null };

function flatten(results: readonly FilterPageResult<SettingsNavPage>[]): FlatResult[] {
  return results.flatMap((r) => [
    { pageId: r.page.id, elementId: null },
    ...r.elements.map((e) => ({ pageId: r.page.id, elementId: e.id })),
  ]);
}

/** Plain page list, shown while the filter is empty. */
function PageList({
  pages,
  activePageId,
  openPage,
  testIdPrefix,
}: Pick<Props, 'pages' | 'activePageId' | 'openPage' | 'testIdPrefix'>) {
  return (
    <SidebarMenu>
      {pages.map((page) => {
        const Icon = page.icon;
        return (
          <SidebarMenuItem key={page.id}>
            <SidebarMenuButton
              isActive={activePageId === page.id}
              onClick={() => openPage(page.id)}
              data-testid={`${testIdPrefix}-nav-${page.id}`}
            >
              <Icon className="icon-base" />
              <span>{page.label}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** Matching pages with their matching settings; the cursor row is highlighted. */
function FilterResults({
  results,
  cursor,
  openResult,
  testIdPrefix,
}: {
  results: readonly FilterPageResult<SettingsNavPage>[];
  cursor: FlatResult | undefined;
  openResult: (result: FlatResult) => void;
  testIdPrefix: string;
}) {
  const tr = useSettingsTranslators();
  const isCursor = (pageId: string, elementId: SettingId | null) =>
    cursor?.pageId === pageId && cursor.elementId === elementId;

  return (
    <SidebarMenu data-testid="settings-filter-results">
      {results.map(({ page, elements }) => {
        const Icon = page.icon;
        return (
          <SidebarMenuItem key={page.id}>
            {/* While filtering, the highlighted row is the keyboard cursor. */}
            <SidebarMenuButton
              isActive={isCursor(page.id, null)}
              onClick={() => openResult({ pageId: page.id, elementId: null })}
              data-testid={`${testIdPrefix}-nav-${page.id}`}
            >
              <Icon className="icon-base" />
              <span>{page.label}</span>
            </SidebarMenuButton>
            {elements.length > 0 && (
              <SidebarMenuSub>
                {elements.map((entry) => (
                  <SidebarMenuSubItem key={entry.id}>
                    <SidebarMenuSubButton asChild size="sm" isActive={isCursor(page.id, entry.id)}>
                      <button
                        type="button"
                        onClick={() => openResult({ pageId: page.id, elementId: entry.id })}
                        data-testid={`settings-filter-result-${entry.id}`}
                      >
                        <span>{tr.t(entry.title, entry.titleDefault ?? entry.title)}</span>
                      </button>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** "N results in Preferences →": opens the other surface on its first match. */
function CrossSurfaceHint({
  scope,
  count,
  onOpen,
}: {
  scope: SettingsScope;
  count: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label =
    scope === 'preferences'
      ? t('settings.filter.inPreferences', {
          count,
          defaultValue: '{{count}} results in Preferences',
        })
      : t('settings.filter.inProject', {
          count,
          defaultValue: '{{count}} results in Project Settings',
        });
  return (
    <div className="mt-2">
      <Button variant="ghost" size="sm" onClick={onOpen} data-testid="settings-filter-cross-hint">
        <span>{label}</span>
        <ArrowRight className="icon-xs" />
      </Button>
    </div>
  );
}

/** The page list, the empty state or the results, depending on the filter. */
function FilterList({
  filtering,
  results,
  cursor,
  openResult,
  ...pageList
}: Pick<Props, 'pages' | 'activePageId' | 'openPage' | 'testIdPrefix'> & {
  filtering: boolean;
  results: readonly FilterPageResult<SettingsNavPage>[];
  cursor: FlatResult | undefined;
  openResult: (result: FlatResult) => void;
}) {
  const { t } = useTranslation();
  if (!filtering) return <PageList {...pageList} />;
  if (results.length === 0) {
    return (
      <p className="text-muted-foreground px-3 py-2 text-sm" data-testid="settings-filter-empty">
        {t('settings.filter.noResults', { defaultValue: 'No settings match' })}
      </p>
    );
  }
  return (
    <FilterResults
      results={results}
      cursor={cursor}
      openResult={openResult}
      testIdPrefix={pageList.testIdPrefix}
    />
  );
}

/** Index of the cursor after an arrow key, wrapping at both ends. */
function moveCursor(index: number, key: 'ArrowDown' | 'ArrowUp', length: number): number {
  const delta = key === 'ArrowDown' ? 1 : -1;
  return (index + delta + length) % length;
}

/**
 * Sidebar navigation of a settings surface with a filter input on top
 * (openspec `settings-filter`). With an empty filter it is the plain page
 * list; otherwise it lists the pages that match, with the matching settings
 * and sections of each page under it, and a hint when the other surface has
 * matches too.
 */
export function SettingsNavFilter({
  scope,
  pages,
  activePageId,
  openPage,
  testIdPrefix,
  other,
}: Props) {
  const { t } = useTranslation();
  const tr = useSettingsTranslators();
  const query = useSettingsFilterStore((s) => s.query);
  const setQuery = useSettingsFilterStore((s) => s.setQuery);
  const setFocusId = useSettingsFilterStore((s) => s.setFocusId);
  const normalized = normalizeSettingsQuery(query);

  const results = useMemo(
    () => filterSettings({ scope, pages, query: normalized, ...tr }),
    [scope, pages, normalized, tr],
  );
  const otherResults = useMemo(
    () =>
      other && normalized
        ? filterSettings({ scope: other.scope, pages: other.pages, query: normalized, ...tr })
        : [],
    [other, normalized, tr],
  );
  const otherCount = countSettingsResults(otherResults);
  const flat = useMemo(() => flatten(results), [results]);

  // The keyboard cursor belongs to one query; a new query starts at the top.
  const [cursor, setCursor] = useState({ query: '', index: 0 });
  const activeIndex = cursor.query === normalized ? cursor.index : 0;

  const openResult = (result: FlatResult) => {
    setFocusId(result.elementId);
    openPage(result.pageId);
  };

  const openOther = () => {
    const first = otherResults[0];
    if (!other || !first) return;
    setFocusId(first.elements[0]?.id ?? null);
    other.openPage(first.page.id);
  };

  const clearQuery = () => {
    if (query) setQuery('');
  };

  const moveTo = (key: 'ArrowDown' | 'ArrowUp') => {
    if (flat.length === 0) return;
    setCursor({ query: normalized, index: moveCursor(activeIndex, key, flat.length) });
  };

  // Enter opens the result under the cursor, else the other scope's first match.
  const openCursor = () => {
    const target = flat[activeIndex];
    if (target) openResult(target);
    else if (otherCount > 0) openOther();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') return clearQuery();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      return moveTo(e.key);
    }
    if (e.key === 'Enter' && normalized) {
      e.preventDefault();
      openCursor();
    }
  };

  const placeholder = t('settings.filter.placeholder', { defaultValue: 'Search settings…' });
  return (
    <>
      <div className="relative pb-2">
        <Search className="icon-sm text-muted-foreground pointer-events-none absolute top-4 left-2.5 -translate-y-1/2" />
        <SidebarInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          className="pl-8"
          data-testid="settings-filter-input"
        />
      </div>
      <FilterList
        filtering={!!normalized}
        results={results}
        cursor={flat[activeIndex]}
        openResult={openResult}
        pages={pages}
        activePageId={activePageId}
        openPage={openPage}
        testIdPrefix={testIdPrefix}
      />
      {other && otherCount > 0 && (
        <CrossSurfaceHint scope={other.scope} count={otherCount} onOpen={openOther} />
      )}
    </>
  );
}
