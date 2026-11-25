import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { act, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { mockT } from '../helpers/mock-i18n';

const mockBrowseFiles = (() => vi.fn())();

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

mock.module('@/lib/api', () => ({
  api: { browseFiles: mockBrowseFiles },
}));

// Show the collapsed folders the pane hands the tree, sorted, so a test can read them.
mock.module('@/components/FileTree', () => ({
  FileTree: ({ collapsedFolders }: { collapsedFolders?: Set<string> }) => (
    <div data-testid="project-files-tree">{[...(collapsedFolders ?? [])].sort().join(',')}</div>
  ),
}));

const { ProjectFilesPane } = await import('@/components/ProjectFilesPane');
const { seedProjects } = await import('@/data/projects/testing');
const { useProjectStore } = await import('@/stores/project-store');

import { renderWithProviders } from '../helpers/render';

const STORAGE_PREFIX = 'project-files-collapsed:';

function seed() {
  // SAFETY: the pane reads only `id` and `path` from a project row.
  seedProjects([{ id: 'p1', path: '/repo-a' } as never, { id: 'p2', path: '/repo-b' } as never]);
}

describe('ProjectFilesPane collapsed folders', () => {
  beforeEach(() => {
    localStorage.clear();
    mockBrowseFiles.mockReset();
    mockBrowseFiles.mockImplementation((path: string) =>
      okAsync({
        files: path === '/repo-a' ? ['src/a.ts', 'docs/readme.md'] : ['lib/b.ts'],
        truncated: false,
      }),
    );
    seed();
    useProjectStore.setState({ selectedProjectId: 'p1' });
  });

  test('collapses every folder after the first load and saves it', async () => {
    renderWithProviders(<ProjectFilesPane />, { threadId: null });
    await waitFor(() =>
      expect(screen.getByTestId('project-files-tree')).toHaveTextContent('docs,src'),
    );
    expect(JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}/repo-a`) ?? '[]').sort()).toEqual([
      'docs',
      'src',
    ]);
  });

  test('restores the saved folders of the project it switches to', async () => {
    localStorage.setItem(`${STORAGE_PREFIX}/repo-a`, JSON.stringify(['src']));
    localStorage.setItem(`${STORAGE_PREFIX}/repo-b`, JSON.stringify([]));
    renderWithProviders(<ProjectFilesPane />, { threadId: null });
    await waitFor(() => expect(screen.getByTestId('project-files-tree')).toHaveTextContent('src'));

    act(() => useProjectStore.setState({ selectedProjectId: 'p2' }));
    await waitFor(() => expect(mockBrowseFiles).toHaveBeenCalledWith('/repo-b', undefined, 10000));
    await waitFor(() => expect(screen.getByTestId('project-files-tree')).toHaveTextContent(/^$/));
    expect(localStorage.getItem(`${STORAGE_PREFIX}/repo-b`)).toBe('[]');
  });

  test('collapses a new project without saved folders once its own files load', async () => {
    renderWithProviders(<ProjectFilesPane />, { threadId: null });
    await waitFor(() =>
      expect(screen.getByTestId('project-files-tree')).toHaveTextContent('docs,src'),
    );

    act(() => useProjectStore.setState({ selectedProjectId: 'p2' }));
    await waitFor(() => expect(screen.getByTestId('project-files-tree')).toHaveTextContent('lib'));
    expect(localStorage.getItem(`${STORAGE_PREFIX}/repo-b`)).toBe('["lib"]');
  });
});
