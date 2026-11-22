import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import '@/i18n/config';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Palette, SlidersHorizontal, Webhook } from 'lucide-react';
import { useState } from 'react';

import { SettingRow, SettingsSection } from '@/components/settings/SettingRow';
import {
  SettingsNavFilter,
  type OtherSettingsSurface,
} from '@/components/settings/SettingsNavFilter';
import {
  useSettingFocusScroll,
  type SettingsNavPage,
} from '@/components/settings/use-settings-filter';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSettingsFilterStore } from '@/stores/settings-filter-store';

// openspec settings-filter: the filter input above both settings sidebars.

const PREFERENCES_PAGES: SettingsNavPage[] = [
  { id: 'general', label: 'General', labelEn: 'General', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', labelEn: 'Appearance', icon: Palette },
];

const PROJECT_PAGES: SettingsNavPage[] = [
  { id: 'hooks', label: 'Hooks', labelEn: 'Hooks', icon: Webhook },
];

function renderFilter(props: {
  other?: OtherSettingsSurface | null;
  openPage?: (id: string) => void;
}) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <SettingsNavFilter
          scope="preferences"
          pages={PREFERENCES_PAGES}
          activePageId="general"
          openPage={props.openPage ?? (() => {})}
          testIdPrefix="preferences"
          other={props.other ?? null}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

function type(text: string) {
  fireEvent.change(screen.getByTestId('settings-filter-input'), { target: { value: text } });
}

beforeEach(() => {
  useSettingsFilterStore.getState().reset();
});

afterEach(() => {
  useSettingsFilterStore.getState().reset();
});

describe('SettingsNavFilter', () => {
  test('an empty filter shows the normal page list', () => {
    renderFilter({});
    expect(screen.getByTestId('preferences-nav-general')).toBeTruthy();
    expect(screen.getByTestId('preferences-nav-appearance')).toBeTruthy();
    expect(screen.queryByTestId('settings-filter-results')).toBeNull();
  });

  test('typing lists matching settings under their page', () => {
    renderFilter({});
    type('font');
    expect(screen.queryByTestId('preferences-nav-general')).toBeNull();
    expect(screen.getByTestId('preferences-nav-appearance')).toBeTruthy();
    expect(screen.getByTestId('settings-filter-result-appearance.font-size')).toBeTruthy();
  });

  test('shows an empty state when nothing matches', () => {
    renderFilter({});
    type('zzz-no-such-setting');
    expect(screen.getByTestId('settings-filter-empty')).toBeTruthy();
  });

  test('selecting a result opens its page and asks to focus the element', () => {
    const openPage = mock((_id: string) => {});
    renderFilter({ openPage });
    type('font');
    fireEvent.click(screen.getByTestId('settings-filter-result-appearance.font-size'));
    expect(openPage).toHaveBeenCalledWith('appearance');
    expect(useSettingsFilterStore.getState().focusId).toBe('appearance.font-size');
    // The filter text survives navigation.
    expect(useSettingsFilterStore.getState().query).toBe('font');
  });

  test('Enter opens the first result and Escape clears the filter', () => {
    const openPage = mock((_id: string) => {});
    renderFilter({ openPage });
    type('font');
    const input = screen.getByTestId('settings-filter-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(openPage).toHaveBeenCalledWith('appearance');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useSettingsFilterStore.getState().query).toBe('');
    expect(screen.getByTestId('preferences-nav-general')).toBeTruthy();
  });

  test('ArrowDown moves to the next result', () => {
    const openPage = mock((_id: string) => {});
    renderFilter({ openPage });
    type('font');
    const input = screen.getByTestId('settings-filter-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSettingsFilterStore.getState().focusId).toBe('appearance.font-size');
  });

  test('the cross-surface hint counts the other surface and opens it', () => {
    const openOther = mock((_id: string) => {});
    renderFilter({ other: { scope: 'project', pages: PROJECT_PAGES, openPage: openOther } });
    type('hooks');
    const hint = screen.getByTestId('settings-filter-cross-hint');
    expect(hint.textContent).toContain('1 result in Project Settings');
    fireEvent.click(hint);
    expect(openOther).toHaveBeenCalledWith('hooks');
    expect(useSettingsFilterStore.getState().query).toBe('hooks');
  });

  test('no hint without another surface (no project selected)', () => {
    renderFilter({ other: null });
    type('hooks');
    expect(screen.queryByTestId('settings-filter-cross-hint')).toBeNull();
  });
});

describe('indexed settings primitives', () => {
  test('render data-setting-id and dim only while the filter does not match', () => {
    render(
      <>
        <SettingRow settingId="appearance.font-size" title="Font size" description="d">
          <span />
        </SettingRow>
        <SettingsSection settingId="appearance.experimental">Experimental</SettingsSection>
      </>,
    );
    const row = document.querySelector('[data-setting-id="appearance.font-size"]')!;
    const section = document.querySelector('[data-setting-id="appearance.experimental"]')!;
    expect(row.className).not.toContain('opacity-50');

    act(() => useSettingsFilterStore.getState().setQuery('font'));
    expect(row.className).not.toContain('opacity-50');
    expect(section.className).toContain('opacity-50');

    act(() => useSettingsFilterStore.getState().setQuery(''));
    expect(section.className).not.toContain('opacity-50');
  });
});

describe('useSettingFocusScroll', () => {
  function Pane() {
    useSettingFocusScroll();
    const [ready, setReady] = useState(false);
    return (
      <>
        <button type="button" data-testid="load" onClick={() => setReady(true)} />
        {ready && (
          <SettingRow settingId="appearance.font-size" title="Font size" description="d">
            <span />
          </SettingRow>
        )}
      </>
    );
  }

  test('waits for a row that mounts late, then scrolls to and highlights it', async () => {
    const scrolled = mock(() => {});
    Element.prototype.scrollIntoView = scrolled;
    render(<Pane />);
    act(() => useSettingsFilterStore.getState().setFocusId('appearance.font-size'));
    expect(scrolled).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('load'));
    // MutationObserver callbacks run as a microtask.
    await act(async () => {
      await Promise.resolve();
    });

    const row = document.querySelector('[data-setting-id="appearance.font-size"]')!;
    expect(scrolled).toHaveBeenCalled();
    expect(row.classList.contains('setting-focus-highlight')).toBe(true);
    expect(useSettingsFilterStore.getState().focusId).toBeNull();
  });
});
