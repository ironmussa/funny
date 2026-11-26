import { describe, expect, test } from 'bun:test';

import { render } from '@testing-library/react';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Command } from '@/components/ui/command';
import { DialogFooter } from '@/components/ui/dialog';
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

// Issue #556 cleared the last shadcn/no-restyle findings and made the rule an
// error. Each case pins that the new variant, size or prop renders what the
// call site used to write by hand.
describe('#556 Button variants and sizes', () => {
  const variants: [string, string, string][] = [
    // [new variant, old variant, old className]
    ['pressed-primary', 'muted', 'text-primary bg-primary/10'],
    ['muted-menu', 'muted', 'data-popup-open:text-foreground data-open:text-foreground'],
    ['ghost-sidebar', 'ghost', 'hover:bg-sidebar-accent'],
    ['ghost-primary', 'muted', 'text-primary hover:text-primary'],
  ];
  test.each(variants)('variant %s = %s + "%s"', (variant, oldVariant, oldClass) => {
    const now = cn(buttonVariants({ variant: variant as 'muted' }));
    const before = cn(buttonVariants({ variant: oldVariant as 'muted', className: oldClass }));
    expect(sorted(now)).toEqual(sorted(before));
  });

  const sizes: [string, string, string][] = [
    // [new size, old size, old className]
    ['3xs-tight', 'sm', 'text-2xs h-5 px-1'],
    ['xs-wide', 'xs', 'px-3'],
    ['xs-submit', 'xs', 'px-3 text-sm'],
    ['inline', 'sm', 'h-auto p-0'],
    ['icon-fit', 'icon-xs', 'size-auto p-1 [&_svg]:size-3.5'],
    ['row', 'default', 'h-auto px-1 py-1'],
    ['touch-row', 'xs', 'h-11 rounded-none px-3'],
  ];
  test.each(sizes)('size %s = %s + "%s"', (size, oldSize, oldClass) => {
    const now = cn(buttonVariants({ size: size as 'xs' }));
    const before = cn(buttonVariants({ size: oldSize as 'xs', className: oldClass }));
    expect(sorted(now)).toEqual(sorted(before));
  });
});

describe('#556 field and container variants', () => {
  test('Input bare-comment and caps', () => {
    const first = (c: HTMLElement) => c.firstElementChild;
    expect(classSet(first(render(<Input variant="bare-comment" />).container))).toEqual(
      withOld(
        first(render(<Input />).container),
        'text-foreground placeholder:text-muted-foreground/50 rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0',
      ),
    );
    expect(classSet(first(render(<Input caps />).container))).toEqual(
      withOld(first(render(<Input />).container), 'uppercase'),
    );
  });

  test('ScrollArea muted-outline-faint / outline', () => {
    const base = () => render(<ScrollArea>x</ScrollArea>).container.firstElementChild;
    const now = (variant: 'muted-outline-faint' | 'outline') =>
      classSet(render(<ScrollArea variant={variant}>x</ScrollArea>).container.firstElementChild);
    expect(now('muted-outline-faint')).toEqual(
      withOld(base(), 'border-border/50 bg-muted rounded border'),
    );
    expect(now('outline')).toEqual(withOld(base(), 'border-border/40 border-r py-3'));
  });

  test('SearchBar column-overlay = the live column find bar over floating', () => {
    const props = { query: '', onQueryChange: () => {}, totalMatches: 0, autoFocus: false };
    const { getByTestId: now } = render(
      <SearchBar {...props} testIdPrefix="a" variant="column-overlay" />,
    );
    const { getByTestId: base } = render(
      <SearchBar {...props} testIdPrefix="b" variant="floating" />,
    );
    expect(classSet(now('a-bar'))).toEqual(
      withOld(
        base('b-bar'),
        'border-border bg-popover gap-1.5 rounded-md border px-2 py-1.5 shadow-md',
      ),
    );
  });

  test('DialogFooter stacked / bordered wide', () => {
    const first = (c: HTMLElement) => c.firstElementChild;
    const plain = () => first(render(<DialogFooter />).container);
    expect(classSet(first(render(<DialogFooter stacked />).container))).toEqual(
      withOld(plain(), 'flex-col gap-1.5 sm:flex-col sm:justify-stretch sm:space-x-0'),
    );
    expect(classSet(first(render(<DialogFooter bordered="wide" />).container))).toEqual(
      withOld(plain(), 'border-border border-t px-6 py-4'),
    );
  });

  test('Command outlined = border', () => {
    const first = (c: HTMLElement) => c.firstElementChild;
    expect(classSet(first(render(<Command outlined />).container))).toEqual(
      withOld(first(render(<Command />).container), 'border'),
    );
  });
});
