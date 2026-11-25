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

/**
 * What a call site that passed `className` rendered: the component merges its
 * own classes with `className` through `cn`, last one winning, so the default
 * render merged with the old classes is the same set.
 */
function withOld(el: Element | null, oldClass: string): string[] {
  return sorted(cn(el?.getAttribute('class') ?? '', oldClass));
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
    const { container: base } = render(<Badge variant="info">x</Badge>);
    expect(classSet(now.firstElementChild)).toEqual(
      withOld(base.firstElementChild, 'text-3xs rounded px-1 py-0 leading-none font-medium'),
    );
  });

  test('muted = secondary + bg-muted text-muted-foreground', () => {
    const { container: now } = render(<Badge variant="muted">x</Badge>);
    const { container: base } = render(<Badge variant="secondary">x</Badge>);
    expect(classSet(now.firstElementChild)).toEqual(
      withOld(base.firstElementChild, 'bg-muted text-muted-foreground'),
    );
  });

  test('weight normal + mono = font-mono font-normal', () => {
    const { container: now } = render(
      <Badge variant="outline" size="xs" weight="normal" mono>
        x
      </Badge>,
    );
    const { container: base } = render(
      <Badge variant="outline" size="xs">
        x
      </Badge>,
    );
    expect(classSet(now.firstElementChild)).toEqual(
      withOld(base.firstElementChild, 'font-mono font-normal'),
    );
  });
});

describe('container variants', () => {
  test('ScrollArea muted / muted-outline / divided', () => {
    const base = () => render(<ScrollArea>x</ScrollArea>).container.firstElementChild;
    const now = (variant: 'muted' | 'muted-outline' | 'divided') =>
      classSet(render(<ScrollArea variant={variant}>x</ScrollArea>).container.firstElementChild);
    expect(now('muted')).toEqual(withOld(base(), 'bg-muted rounded'));
    expect(now('muted-outline')).toEqual(withOld(base(), 'border-border bg-muted rounded border'));
    expect(now('divided')).toEqual(withOld(base(), 'border-border/40 border-t'));
  });

  test('SearchBar floating = the find bar hand-written in ThreadSearchBar', () => {
    const props = { query: '', onQueryChange: () => {}, totalMatches: 0, autoFocus: false };
    const { getByTestId: now } = render(
      <SearchBar {...props} testIdPrefix="a" variant="floating" />,
    );
    const { getByTestId: base } = render(<SearchBar {...props} testIdPrefix="b" />);
    expect(classSet(now('a-bar'))).toEqual(
      withOld(
        base('b-bar'),
        'border-border bg-popover gap-1.5 rounded-b-lg border border-t-0 px-2 py-1.5 shadow-md',
      ),
    );
  });

  test('EmptyState surface and inset', () => {
    const first = (c: HTMLElement) => c.firstElementChild;
    const plain = first(render(<EmptyState title="t" fill={false} />).container);
    const padded = () =>
      first(render(<EmptyState title="t" fill={false} padding="md" />).container);
    expect(
      classSet(first(render(<EmptyState title="t" fill={false} surface="dashed" />).container)),
    ).toEqual(withOld(plain, 'rounded-md border border-dashed p-6'));
    expect(
      classSet(
        first(
          render(<EmptyState title="t" fill={false} padding="md" surface="dashed-muted" />)
            .container,
        ),
      ),
    ).toEqual(withOld(padded(), 'border-border/50 rounded-lg border border-dashed'));
    expect(
      classSet(
        first(render(<EmptyState title="t" fill={false} padding="md" surface="card" />).container),
      ),
    ).toEqual(withOld(padded(), 'settings-card'));
    expect(
      classSet(first(render(<EmptyState title="t" fill={false} inset="sm" />).container)),
    ).toEqual(withOld(plain, 'px-2'));
  });

  test('Skeleton corners and Input inset', () => {
    const { container: a } = render(<Skeleton corners="circle" />);
    const { container: b } = render(<Skeleton />);
    expect(classSet(a.firstElementChild)).toEqual(withOld(b.firstElementChild, 'rounded-full'));

    const { container: c } = render(<Input inset="icon" />);
    const { container: d } = render(<Input />);
    expect(classSet(c.firstElementChild)).toEqual(withOld(d.firstElementChild, 'pl-8'));
  });
});
