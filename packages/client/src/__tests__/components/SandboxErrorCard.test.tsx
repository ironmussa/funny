import type { ThreadEvent } from '@funny/shared';
import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { SandboxErrorCard } from '@/components/thread/SandboxErrorCard';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const event = (data: Record<string, unknown>): ThreadEvent => ({
  id: 'ev-1',
  threadId: 't-1',
  type: 'sandbox:error',
  data: JSON.stringify(data),
  createdAt: new Date().toISOString(),
});

describe('SandboxErrorCard', () => {
  test("shows what failed, the provider's message and what to do", () => {
    renderWithProviders(
      <SandboxErrorCard
        event={event({
          phase: 'setup',
          kind: 'quota',
          message: 'Trial accounts can run 2 concurrent sandboxes.',
          hint: "The sandbox provider's plan limit was reached.",
        })}
      />,
    );
    const card = screen.getByTestId('sandbox-error-card-ev-1');
    expect(card).toHaveTextContent('The sandbox could not be prepared');
    expect(card).toHaveTextContent('Trial accounts can run 2 concurrent sandboxes.');
    expect(card).toHaveTextContent("The sandbox provider's plan limit was reached.");
  });

  test('a failed wake says the sandbox could not be resumed', () => {
    renderWithProviders(<SandboxErrorCard event={event({ phase: 'wake', message: 'expired' })} />);
    expect(screen.getByTestId('sandbox-error-card-ev-1')).toHaveTextContent(
      'The sandbox could not be resumed',
    );
  });
});
