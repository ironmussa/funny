import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { SearchBar } from '@/components/ui/search-bar';

const requiredProps = {
  query: '',
  onQueryChange: vi.fn(),
  totalMatches: 0,
};

describe('SearchBar', () => {
  test('forwards input refs and clears them on unmount', () => {
    const objectRef = createRef<HTMLInputElement>();
    const callbackRef = vi.fn<(node: HTMLInputElement | null) => void>();

    const { unmount, rerender } = render(
      <SearchBar {...requiredProps} autoFocus={false} inputRef={objectRef} />,
    );

    expect(objectRef.current).toBeInstanceOf(HTMLInputElement);

    rerender(<SearchBar {...requiredProps} autoFocus={false} inputRef={callbackRef} />);

    expect(objectRef.current).toBeNull();
    expect(callbackRef).toHaveBeenLastCalledWith(expect.any(HTMLInputElement));

    unmount();
    expect(callbackRef).toHaveBeenLastCalledWith(null);
  });
});
