import { render } from '@testing-library/react';
import { forwardRef, memo, useEffect, useLayoutEffect } from 'react';
import { expect, test } from 'vitest';

import { useStableCallback } from '@/hooks/use-stable-callback';

// React 19.2.7 leaves `useEffectEvent` one render behind inside memo() and
// forwardRef components; useStableCallback must not.
function useProbe(seen: string[], value: string) {
  const read = useStableCallback(() => value);
  useEffect(() => {
    seen.push(read());
  }, [value, read, seen]);
  return read;
}

interface HostProps {
  seen: string[];
  value: string;
}

function Plain({ seen, value }: HostProps) {
  useProbe(seen, value);
  return null;
}
const Memo = memo(function MemoHost({ seen, value }: HostProps) {
  useProbe(seen, value);
  return null;
});
const Forwarded = forwardRef<HTMLDivElement, HostProps>(function ForwardedHost(
  { seen, value },
  _ref,
) {
  useProbe(seen, value);
  return null;
});

test.each([
  ['a plain component', Plain],
  ['a memo() component', Memo],
  ['a forwardRef component', Forwarded],
])('reads the latest value in an effect of %s', (_name, Host) => {
  const seen: string[] = [];
  const view = render(<Host seen={seen} value="a" />);
  view.rerender(<Host seen={seen} value="b" />);
  expect(seen).toEqual(['a', 'b']);
});

test('keeps one identity across renders', () => {
  const identities = new Set<unknown>();
  function Host({ value }: { value: string }) {
    identities.add(useStableCallback(() => value));
    return null;
  }
  const view = render(<Host value="a" />);
  view.rerender(<Host value="b" />);
  expect(identities.size).toBe(1);
});

test("is up to date in a child's layout effect", () => {
  const seen: string[] = [];
  function Child({ read }: { read: () => string }) {
    useLayoutEffect(() => {
      seen.push(read());
    });
    return null;
  }
  function Parent({ value }: { value: string }) {
    const read = useStableCallback(() => value);
    return <Child read={read} />;
  }
  const view = render(<Parent value="a" />);
  view.rerender(<Parent value="b" />);
  expect(seen).toEqual(['a', 'b']);
});
