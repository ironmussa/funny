import { screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MessageContent } from '@/components/thread/MessageContent';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';

import { renderWithProviders } from '../helpers/render';

describe('MessageContent', () => {
  beforeEach(() => {
    useSettingsStore.setState({ defaultEditor: 'cursor', useInternalEditor: false });
    useAppStore.setState({
      projects: [{ id: 'p1', name: 'funny', path: '/home/u/projects/funny' } as any],
      selectedProjectId: 'p1',
      activeThread: { id: 't1', projectId: 'p1', worktreePath: null } as any,
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({ projects: [], selectedProjectId: null, activeThread: null });
  });

  test('opens absolute local markdown links in the configured editor', async () => {
    renderWithProviders(
      <MessageContent content="[MessageContent.tsx](/home/u/projects/funny/packages/client/src/components/thread/MessageContent.tsx:42)" />,
    );

    const link = await screen.findByRole('link', { name: 'MessageContent.tsx' });
    expect(link).toHaveAttribute(
      'href',
      'cursor://file/home/u/projects/funny/packages/client/src/components/thread/MessageContent.tsx:42',
    );
    expect(link).not.toHaveAttribute('target');
  });

  test('resolves repo-relative markdown links before opening in the configured editor', async () => {
    renderWithProviders(
      <MessageContent content="[editor-utils.ts](packages/client/src/lib/editor-utils.ts)" />,
    );

    const link = await screen.findByRole('link', { name: 'editor-utils.ts' });
    expect(link).toHaveAttribute(
      'href',
      'cursor://file/home/u/projects/funny/packages/client/src/lib/editor-utils.ts',
    );
  });

  test('renders sanitized GitHub-style raw HTML in bot markdown', async () => {
    const content = [
      '<!-- walkthrough_start -->',
      '<details><summary>📝 Walkthrough</summary>',
      '',
      '| Layer / File(s) | Summary |',
      '| --- | --- |',
      '| Batched upsert<br>`app/Http/Controllers/Foo.php` | Uses one update call |',
      '',
      '</details>',
      '<details><summary>🎁 Summarized by CodeRabbit Free</summary>',
      'Your organization is on the Free plan.',
      '</details>',
      '<!-- walkthrough_end -->',
    ].join('\n');

    const { container } = renderWithProviders(<MessageContent content={content} />);

    expect(await screen.findByText('📝 Walkthrough')).toBeInTheDocument();
    expect(screen.getByText('🎁 Summarized by CodeRabbit Free')).toBeInTheDocument();
    expect(container.querySelectorAll('details')).toHaveLength(2);
    expect(container.querySelector('br')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('<details>');
    expect(container).not.toHaveTextContent('</details>');
  });

  test('sanitizes executable raw HTML after parsing allowed tags', async () => {
    const { container } = renderWithProviders(
      <MessageContent
        content={
          '<details onclick="alert(1)" open><summary>Safe</summary><a href="javascript:alert(1)" onclick="alert(1)">bad link</a><script>alert(1)</script></details>'
        }
      />,
    );

    expect(await screen.findByText('Safe')).toBeInTheDocument();
    const details = container.querySelector('details');
    expect(details).toBeInTheDocument();
    expect(details).toHaveAttribute('open');
    expect(details).not.toHaveAttribute('onclick');

    const link = screen.getByText('bad link');
    expect(link).not.toHaveAttribute('href');
    expect(link).not.toHaveAttribute('onclick');
    expect(container.querySelector('script')).not.toBeInTheDocument();
  });
});
