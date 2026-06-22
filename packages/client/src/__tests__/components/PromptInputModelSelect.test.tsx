import { screen } from '@testing-library/react';
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
