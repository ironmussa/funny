import { describe, expect, test } from 'bun:test';

import { render } from '@testing-library/react';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Issue #453 moved the classes call sites wrote by hand (and shadcn/no-restyle
// reported) into variants. Each case pins that the variant renders the same
// classes the call site used to write, so the move changes nothing on screen.

/** The classes of `el`, sorted, so the order tailwind-merge keeps does not matter. */
function classSet(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).sort();
}

function sorted(classes: string): string[] {
  return classes.split(/\s+/).filter(Boolean).sort();
}

describe('Button variants replace hand-written ghost colors', () => {
  const cases: [string, string, string][] = [
    // [new variant, old variant, old className]
    ['active', 'ghost', 'text-foreground'],
    ['pressed', 'muted', 'bg-accent text-accent-foreground'],
    ['ghost-success', 'ghost', 'text-status-success hover:text-status-success/80'],
    ['ghost-error', 'ghost', 'text-status-error hover:text-status-error/80'],
    ['ghost-info', 'ghost', 'text-status-info hover:text-status-info/80'],
    ['ghost-divided', 'ghost', 'border-t'],
  ];
  test.each(cases)('%s = %s + "%s"', (variant, oldVariant, oldClass) => {
    const { getByRole } = render(
      <Button variant={variant as 'active'} size="icon-sm">
        x
      </Button>,
    );
    const before = cn(
      buttonVariants({ variant: oldVariant as 'ghost', size: 'icon-sm', className: oldClass }),
    );
    expect(classSet(getByRole('button'))).toEqual(sorted(before));
  });
});

describe('Badge variants', () => {
  test('size 3xs = the activity panel chip classes', () => {
    const { container: now } = render(
      <Badge variant="info" size="3xs">
        x
      </Badge>,
    );
    const { container: then } = render(
      <Badge variant="info" className="text-3xs rounded px-1 py-0 leading-none font-medium">
        x
      </Badge>,
    );
    expect(classSet(now.firstElementChild)).toEqual(classSet(then.firstElementChild));
  });

  test('muted = secondary + bg-muted text-muted-foreground', () => {
    const { container: now } = render(<Badge variant="muted">x</Badge>);
    const { container: then } = render(
      <Badge variant="secondary" className="bg-muted text-muted-foreground">
        x
      </Badge>,
    );
    expect(classSet(now.firstElementChild)).toEqual(classSet(then.firstElementChild));
  });

  test('weight normal + mono = font-mono font-normal', () => {
    const { container: now } = render(
      <Badge variant="outline" size="xs" weight="normal" mono>
        x
      </Badge>,
    );
    const { container: then } = render(
      <Badge variant="outline" size="xs" className="font-mono font-normal">
        x
      </Badge>,
    );
    expect(classSet(now.firstElementChild)).toEqual(classSet(then.firstElementChild));
  });
});

describe('container variants', () => {
  test('ScrollArea muted / muted-outline / divided', () => {
    const same = (a: HTMLElement, b: HTMLElement) =>
      expect(classSet(a.firstElementChild)).toEqual(classSet(b.firstElementChild));
    same(
      render(<ScrollArea variant="muted">x</ScrollArea>).container,
      render(<ScrollArea className="bg-muted rounded">x</ScrollArea>).container,
    );
    same(
      render(<ScrollArea variant="muted-outline">x</ScrollArea>).container,
      render(<ScrollArea className="border-border bg-muted rounded border">x</ScrollArea>)
        .container,
    );
    same(
      render(<ScrollArea variant="divided">x</ScrollArea>).container,
      render(<ScrollArea className="border-border/40 border-t">x</ScrollArea>).container,
    );
  });

  test('SearchBar floating = the find bar hand-written in ThreadSearchBar', () => {
    const props = { query: '', onQueryChange: () => {}, totalMatches: 0, autoFocus: false };
    const { getByTestId: now } = render(
      <SearchBar {...props} testIdPrefix="a" variant="floating" />,
    );
    const { getByTestId: then } = render(
      <SearchBar
        {...props}
        testIdPrefix="b"
        className="border-border bg-popover gap-1.5 rounded-b-lg border border-t-0 px-2 py-1.5 shadow-md"
      />,
    );
    expect(classSet(now('a-bar'))).toEqual(classSet(then('b-bar')));
  });

  test('EmptyState surface and inset', () => {
    const same = (a: HTMLElement, b: HTMLElement) =>
      expect(classSet(a.firstElementChild)).toEqual(classSet(b.firstElementChild));
    same(
      render(<EmptyState title="t" fill={false} surface="dashed" />).container,
      render(<EmptyState title="t" fill={false} className="rounded-md border border-dashed p-6" />)
        .container,
    );
    same(
      render(<EmptyState title="t" fill={false} padding="md" surface="dashed-muted" />).container,
      render(
        <EmptyState
          title="t"
          fill={false}
          padding="md"
          className="border-border/50 rounded-lg border border-dashed"
        />,
      ).container,
    );
    same(
      render(<EmptyState title="t" fill={false} padding="md" surface="card" />).container,
      render(<EmptyState title="t" fill={false} padding="md" className="settings-card" />)
        .container,
    );
    same(
      render(<EmptyState title="t" fill={false} inset="sm" />).container,
      render(<EmptyState title="t" fill={false} className="px-2" />).container,
    );
  });

  test('Skeleton corners and Input inset', () => {
    const { container: a } = render(<Skeleton corners="circle" className="size-3.5" />);
    const { container: b } = render(<Skeleton className="size-3.5 rounded-full" />);
    expect(classSet(a.firstElementChild)).toEqual(classSet(b.firstElementChild));

    const { container: c } = render(<Input inset="icon" />);
    const { container: d } = render(<Input className="pl-8" />);
    expect(classSet(c.firstElementChild)).toEqual(classSet(d.firstElementChild));
  });
});
