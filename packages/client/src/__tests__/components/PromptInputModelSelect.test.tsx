import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ModelSelect } from '@/components/PromptInputUI';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('ModelSelect', () => {
  test('shows the provider in the selected model trigger', () => {
    renderWithProviders(
      <ModelSelect
        value="codex:gpt-5.5"
        effort="high"
        onChange={vi.fn()}
        onEffortChange={vi.fn()}
        groups={[
          {
            provider: 'codex',
            providerLabel: 'Codex',
            models: [{ value: 'codex:gpt-5.5', label: 'GPT-5.5' }],
          },
        ]}
      />,
    );

    expect(screen.getByTestId('prompt-model-select')).toHaveTextContent(
      /Codex\s*·\s*GPT-5\.5\s*·\s*High/,
    );
  });
});

test('model menu scrolls within available height and effort selection escapes its scroll container', async () => {
  const onChange = vi.fn();
  const onEffortChange = vi.fn();
  renderWithProviders(
    <ModelSelect
      value="codex:gpt-5.5"
      effort="high"
      onChange={onChange}
      onEffortChange={onEffortChange}
      groups={[
        {
          provider: 'codex',
          providerLabel: 'Codex',
          models: [{ value: 'codex:gpt-5.5', label: 'GPT-5.5' }],
        },
      ]}
    />,
  );

  fireEvent.keyDown(screen.getByTestId('prompt-model-select'), { key: 'ArrowDown' });
  const menu = await screen.findByRole('menu');
  // jsdom has no layout: verify the viewport constraint, then exercise the
  // portaled submenu so adding overflow cannot silently clip effort choices.
  expect(menu).toHaveClass(
    'max-h-[var(--radix-dropdown-menu-content-available-height)]',
    'overflow-y-auto',
    'overscroll-contain',
  );
  const model = screen.getByTestId('prompt-model-option-codex:gpt-5.5');
  model.focus();
  fireEvent.keyDown(model, { key: 'ArrowRight' });
  const effort = await screen.findByTestId('prompt-effort-option-codex:gpt-5.5-high');
  expect(menu).not.toContainElement(effort);
  expect(effort.closest('[role="menu"]')).toHaveClass(
    'max-h-[var(--radix-dropdown-menu-content-available-height)]',
    'overflow-y-auto',
  );
  fireEvent.click(effort);
  expect(onChange).toHaveBeenCalledWith('codex:gpt-5.5');
  expect(onEffortChange).toHaveBeenCalledWith('high');
});
