import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GenericToolCard } from '@/components/tool-cards/GenericToolCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('GenericToolCard', () => {
  test('syntax highlights JSON-valued tool parameters', async () => {
    const { container } = render(
      <GenericToolCard
        name="Grep"
        parsed={{
          parsed_cmd: [
            {
              type: 'search',
              cmd: 'rg -n "faces" model_A003_body_anchor_v3.log',
              path: 'model_A003_body_anchor_v3.log',
            },
          ],
        }}
        label="Search Code"
        displayTime={null}
        summary={null}
        filePath={null}
        displayPath={null}
        isTodo={false}
        todos={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /search code/i }));

    expect(screen.getByText('parsed_cmd')).toBeInTheDocument();
    expect(screen.getByText(/"type": "search"/)).toBeInTheDocument();

    await waitFor(() => {
      const jsonKey = Array.from(container.querySelectorAll('.language-json .hljs-attr')).find(
        (node) => node.textContent === '"type"',
      );
      expect(jsonKey).toBeTruthy();
    });
  });
});
