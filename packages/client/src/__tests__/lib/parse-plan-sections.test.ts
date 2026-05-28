import { describe, test, expect } from 'vitest';

import { parsePlanSections } from '@/lib/parse-plan-sections';

describe('parsePlanSections', () => {
  test('returns a single preamble section when there are no headings', () => {
    const sections = parsePlanSections('Just a plan\nwith no headings');

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      id: 0,
      title: '',
      level: 0,
      content: 'Just a plan\nwith no headings',
    });
  });

  test('splits markdown on # and ## headings', () => {
    const markdown = ['Preamble', '', '## Step 1', 'Do thing A', '# Summary', 'Wrap up'].join('\n');
    const sections = parsePlanSections(markdown);

    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatchObject({ title: '', level: 0, content: 'Preamble' });
    expect(sections[1]).toMatchObject({ title: 'Step 1', level: 2, content: 'Do thing A' });
    expect(sections[2]).toMatchObject({ title: 'Summary', level: 1, content: 'Wrap up' });
  });

  test('assigns incrementing ids in document order', () => {
    const sections = parsePlanSections('## A\na\n## B\nb');

    expect(sections.map((s) => s.id)).toEqual([0, 1]);
  });

  test('ignores headings deeper than h4 for splitting', () => {
    const sections = parsePlanSections('##### Deep\nstill content');

    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain('##### Deep');
  });
});
