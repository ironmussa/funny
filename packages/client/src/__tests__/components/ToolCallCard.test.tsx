import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ToolCallCard } from '@/components/ToolCallCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@/stores/thread-context', () => ({
  useThreadProjectId: () => undefined,
  useThreadWorktreePath: () => undefined,
  useThreadSelector: () => undefined,
}));

vi.mock('@/stores/project-store', () => {
  const useProjectStore = Object.assign(
    (selector: (state: { projects: never[] }) => unknown) => selector({ projects: [] }),
    { subscribe: () => () => {} },
  );
  return { useProjectStore };
});

vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (selector: (state: { defaultEditor: string }) => unknown) =>
    selector({ defaultEditor: 'cursor' }),
}));

vi.mock('@/components/tool-cards/dispatch', () => ({
  dispatchToolCard: () => null,
}));

describe('ToolCallCard', () => {
  test('renders ProviderError ANSI sequences as formatting instead of visible text', () => {
    const providerError =
      '**Provider stderr:** \u001b[2m2026-07-09T02:17:01.652760Z\u001b[0m \u001b[31mERROR\u001b[0m invalid_token';

    const { container } = render(
      <ToolCallCard name="ProviderError" input={{ error: providerError }} output={providerError} />,
    );

    expect(container.textContent).toContain('2026-07-09T02:17:01.652760Z ERROR invalid_token');
    expect(container.textContent).not.toContain('\u001b[');

    fireEvent.click(screen.getByRole('button', { name: /tools\.providerError/i }));

    expect(screen.getByText('error')).toBeInTheDocument();
    expect(container.textContent).toContain('Provider stderr:');
    expect(container.textContent).not.toContain('\u001b[');
    expect(container.innerHTML).toContain('color');
  });

  test('does not crash when the summary resolves to a non-string value', () => {
    // `getSummary`'s `as string` casts are unsafe: an MCP tool can supply a
    // non-string field (here a number), which reaches the summary untouched.
    // Stripping ANSI must not call `.replace` on it and blow up the thread view.
    expect(() =>
      render(<ToolCallCard name="some__mcp__tool" input={{ description: 12345 }} />),
    ).not.toThrow();

    expect(screen.getByText('12345')).toBeInTheDocument();
  });
});
