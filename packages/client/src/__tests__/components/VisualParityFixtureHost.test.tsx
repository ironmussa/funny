import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { desktopParityFixture } from '@funny/ui-contracts/fixtures';
import { referenceDark } from '@funny/ui-contracts/tokens';
import { render, screen } from '@testing-library/react';

import { VisualParityFixtureHost } from '@/components/visual-parity/VisualParityFixtureHost';

// The proof and pre-push run these files together under `bun test --parallel`; on a
// loaded machine a first render (cold module load) ran well past the 5 s default.
setDefaultTimeout(60_000);

describe('VisualParityFixtureHost', () => {
  test('renders the shared desktop structure and tokens', () => {
    render(<VisualParityFixtureHost fixture={desktopParityFixture} />);
    const root = screen.getByTestId(`parity-fixture-${desktopParityFixture.id}`);
    expect(root.style.getPropertyValue('--parity-canvas')).toBe(referenceDark.colors.canvas);
    expect(root).toHaveClass('[background:var(--parity-canvas)]');
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
