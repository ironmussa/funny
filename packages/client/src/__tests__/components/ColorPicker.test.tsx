import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ColorPicker, ColorPickerFormat } from '@/components/ui/color-picker';

describe('ColorPicker', () => {
  test('emits rgba values when committing a hex color', () => {
    const onChange = vi.fn();

    render(
      <ColorPicker defaultValue="#000000" onChange={onChange}>
        <ColorPickerFormat />
      </ColorPicker>,
    );

    const [hexInput] = screen.getAllByRole('textbox');
    fireEvent.change(hexInput, { target: { value: '#ffffff' } });

    expect(onChange).toHaveBeenLastCalledWith([255, 255, 255, 1]);
  });
});
