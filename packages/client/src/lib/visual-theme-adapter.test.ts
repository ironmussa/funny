import { oneDark, referenceDark } from '@funny/ui-contracts/tokens';
import { describe, expect, test } from 'vitest';

import { createVisualCssVariables } from './visual-theme-adapter';

describe('visual theme adapter', () => {
  test('maps shared semantic roles to web variables', () => {
    const variables = createVisualCssVariables(referenceDark);
    expect(variables['--background']).toBe(referenceDark.colors.canvas);
    expect(variables['--sidebar-background']).toBe(referenceDark.colors.sidebar);
    expect(variables['--ring']).toBe(referenceDark.colors.borderStrong);
  });

  test('maps the selectable React one-dark contract', () => {
    const variables = createVisualCssVariables(oneDark);
    expect(variables['--background']).toBe(oneDark.colors.canvas);
    expect(variables['--sidebar-background']).toBe(oneDark.colors.sidebar);
  });
});
