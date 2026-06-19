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
});
