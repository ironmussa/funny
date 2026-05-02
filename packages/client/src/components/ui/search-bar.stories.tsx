import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';

import { SearchBar, type SearchBarProps } from '@/components/ui/search-bar';

const SAMPLE_ITEMS = [
  'README.md',
  'package.json',
  'src/index.ts',
  'src/App.tsx',
  'src/components/Button.tsx',
  'src/components/Dialog.tsx',
  'src/lib/utils.ts',
  'src/stores/app-store.ts',
  'tests/app.test.ts',
  'tests/utils.test.ts',
];

function ListFilterDemo(props: Partial<SearchBarProps>) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  const filtered = useMemo(() => {
    if (!query) return SAMPLE_ITEMS;
    if (caseSensitive) return SAMPLE_ITEMS.filter((s) => s.includes(query));
    const q = query.toLowerCase();
    return SAMPLE_ITEMS.filter((s) => s.toLowerCase().includes(q));
  }, [query, caseSensitive]);

  return (
    <div className="w-[420px] space-y-2 rounded-md border border-border bg-background p-2">
      <SearchBar
        {...props}
        query={query}
        onQueryChange={setQuery}
        totalMatches={filtered.length}
        resultLabel={query ? `${filtered.length}/${SAMPLE_ITEMS.length}` : ''}
        caseSensitive={caseSensitive}
        onCaseSensitiveChange={setCaseSensitive}
        onClose={query ? () => setQuery('') : undefined}
      />
      <ul className="max-h-60 overflow-auto text-xs">
        {filtered.map((s) => (
          <li key={s} className="border-b border-border/50 px-2 py-1 last:border-b-0">
            {s}
          </li>
        ))}
        {filtered.length === 0 && <li className="px-2 py-2 text-muted-foreground">No matches</li>}
      </ul>
    </div>
  );
}

function FindInTextDemo() {
  const text = 'The quick brown fox jumps over the lazy dog. The fox is quick.';
  const [query, setQuery] = useState('the');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [index, setIndex] = useState(0);

  const matches = useMemo(() => {
    if (!query) return [] as number[];
    const result: number[] = [];
    const t = caseSensitive ? text : text.toLowerCase();
    const q = caseSensitive ? query : query.toLowerCase();
    let i = 0;
    while ((i = t.indexOf(q, i)) !== -1) {
      result.push(i);
      i += q.length;
    }
    return result;
  }, [query, caseSensitive]);

  const safeIndex = matches.length === 0 ? 0 : Math.min(index, matches.length - 1);

  return (
    <div className="w-[480px] space-y-2 rounded-md border border-border bg-background p-2">
      <SearchBar
        query={query}
        onQueryChange={(v) => {
          setQuery(v);
          setIndex(0);
        }}
        totalMatches={matches.length}
        currentIndex={matches.length > 0 ? safeIndex : undefined}
        onPrev={() => setIndex((i) => (i - 1 + matches.length) % matches.length)}
        onNext={() => setIndex((i) => (i + 1) % matches.length)}
        onClose={() => setQuery('')}
        caseSensitive={caseSensitive}
        onCaseSensitiveChange={setCaseSensitive}
      />
      <p className="whitespace-pre-wrap text-xs leading-relaxed">{text}</p>
    </div>
  );
}

const meta = {
  title: 'UI/SearchBar',
  component: SearchBar,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ListFilter: Story = {
  name: 'List filter (count + case-sensitive)',
  render: () => <ListFilterDemo placeholder="Filter files…" />,
};

export const ListFilterNoCase: Story = {
  name: 'List filter (no case toggle)',
  render: () => {
    function Demo() {
      const [query, setQuery] = useState('');
      const filtered = query
        ? SAMPLE_ITEMS.filter((s) => s.toLowerCase().includes(query.toLowerCase()))
        : SAMPLE_ITEMS;
      return (
        <div className="w-[420px] rounded-md border border-border bg-background p-2">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            placeholder="Search project…"
            totalMatches={filtered.length}
            resultLabel={query ? `${filtered.length}/${SAMPLE_ITEMS.length}` : ''}
            onClose={query ? () => setQuery('') : undefined}
            autoFocus={false}
          />
        </div>
      );
    }
    return <Demo />;
  },
};

export const FindInText: Story = {
  name: 'Find in text (prev/next nav)',
  render: () => <FindInTextDemo />,
};

export const Loading: Story = {
  name: 'Loading (debounced server search)',
  render: () => {
    function Demo() {
      const [query, setQuery] = useState('react');
      return (
        <div className="w-[420px] rounded-md border border-border bg-background p-2">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            placeholder="Search GitHub repos…"
            totalMatches={42}
            resultLabel={query ? '42' : ''}
            loading
            onClose={query ? () => setQuery('') : undefined}
            autoFocus={false}
          />
        </div>
      );
    }
    return <Demo />;
  },
};

export const Empty: Story = {
  name: 'Empty (no count, no close button)',
  render: () => {
    function Demo() {
      const [query, setQuery] = useState('');
      return (
        <div className="w-[420px] rounded-md border border-border bg-background p-2">
          <SearchBar
            query={query}
            onQueryChange={setQuery}
            placeholder="Type to search…"
            totalMatches={0}
            resultLabel=""
            autoFocus={false}
          />
        </div>
      );
    }
    return <Demo />;
  },
};
