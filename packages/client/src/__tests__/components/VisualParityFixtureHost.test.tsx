import { desktopParityFixture } from '@funny/ui-contracts/fixtures';
import { referenceDark } from '@funny/ui-contracts/tokens';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { VisualParityFixtureHost } from '@/components/visual-parity/VisualParityFixtureHost';

describe('VisualParityFixtureHost', () => {
  test('renders the shared desktop structure and tokens', () => {
    render(<VisualParityFixtureHost fixture={desktopParityFixture} />);
    const root = screen.getByTestId(`parity-fixture-${desktopParityFixture.id}`);
    expect(root).toHaveStyle({ background: referenceDark.colors.canvas });
    expect(root.querySelectorAll('[data-parity-role="navigation"] [data-parity-id]')).toHaveLength(
      desktopParityFixture.navigation.length,
    );
    expect(
      root.querySelectorAll('[data-parity-role="conversation"] [data-parity-id]'),
    ).toHaveLength(desktopParityFixture.conversation.length);
    expect(root.querySelector('[data-parity-role="composer"]')).toHaveAttribute(
      'data-lifecycle',
      'idle',
    );
  });
});
