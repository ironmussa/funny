import { describe, expect, it } from 'vitest';

import { buttonVariants } from '@/components/ui/button';
import { FIELD_SIZE, type ControlSize } from '@/components/ui/control-size';
import { inputVariants } from '@/components/ui/input';
import { selectTriggerVariants } from '@/components/ui/select';

/**
 * Regression guard for the single source of truth on control sizing.
 *
 * Buttons, inputs and selects must all read their height from FIELD_SIZE so
 * that `size="sm"` (or any other name) is the SAME height across every form
 * control. Before control-size.ts existed each primitive defined its own
 * height map and they silently disagreed (a `Button size="sm"` was 36px while
 * a `Select size="sm"` was 32px), so rows of mixed controls never lined up.
 * If anyone re-hardcodes a divergent height, these assertions fail.
 */

/** Pull the `h-*` height utility out of FIELD_SIZE for a given size. */
function expectedHeight(size: ControlSize): string {
  const h = FIELD_SIZE[size].split(' ').find((c) => c.startsWith('h-'));
  if (!h) throw new Error(`FIELD_SIZE.${size} has no height utility`);
  return h;
}

const SIZES: ControlSize[] = ['xs', 'sm', 'md', 'lg'];

describe('control sizing — single source of truth', () => {
  it.each(SIZES)('button / input / select share the same height at size=%s', (size) => {
    const height = expectedHeight(size);
    const classes = [
      buttonVariants({ size }),
      inputVariants({ size }),
      selectTriggerVariants({ size }),
    ];
    for (const cls of classes) {
      expect(cls.split(' ')).toContain(height);
    }
  });

  it('app default density is sm (32px / h-8) for every control', () => {
    // No explicit size → the shared default. All three must resolve to h-8.
    expect(buttonVariants().split(' ')).toContain('h-8');
    expect(inputVariants().split(' ')).toContain('h-8');
    expect(selectTriggerVariants().split(' ')).toContain('h-8');
  });
});
