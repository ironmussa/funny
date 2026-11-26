import { create } from 'zustand';

/**
 * A pull request or issue to show in funny's own view (the PR detail dialog or
 * the issue detail dialog). PR and issue chips open it on click; their external
 * link icon is what goes to GitHub.
 */
export interface GitHubItemTarget {
  kind: 'pr' | 'issue';
  projectId: string;
  number: number;
  /** The item's GitHub URL, when the chip knows it: the fallback and the repository check. */
  url?: string;
}

interface GitHubItemViewerState {
  target: GitHubItemTarget | null;
  open: (target: GitHubItemTarget) => void;
  close: () => void;
}

export const useGitHubItemViewerStore = create<GitHubItemViewerState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export function openGitHubItem(target: GitHubItemTarget): void {
  useGitHubItemViewerStore.getState().open(target);
}

/** `owner/repo` of a GitHub URL, lower-cased; `null` for anything else. */
export function githubRepoOfUrl(url: string | undefined): string | null {
  const match = url?.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/#?]+)/i);
  return match ? match[1].toLowerCase() : null;
}
