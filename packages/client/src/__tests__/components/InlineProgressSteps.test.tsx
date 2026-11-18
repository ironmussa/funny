import { screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { InlineProgressSteps } from '@/components/InlineProgressSteps';

import { renderWithProviders } from '../helpers/render';

describe('InlineProgressSteps', () => {
  test('a failed step shows its error without the color escapes a hook printed', () => {
    const esc = String.fromCharCode(27);
    renderWithProviders(
      <InlineProgressSteps
        steps={[
          {
            id: 'hooks',
            label: 'Run pre-commit hooks',
            status: 'failed',
            error: `${esc}[31m✗ oxlint${esc}[0m: 2 errors`,
          },
        ]}
        showTotal={false}
      />,
    );
    expect(screen.getByText('✗ oxlint: 2 errors')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(esc);
  });
});
