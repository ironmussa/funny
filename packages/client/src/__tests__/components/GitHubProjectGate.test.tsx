import { act, render, screen } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { GitHubProjectGate } from '@/components/GitHubProjectGate';

const state = vi.hoisted(() => ({ projectId: 'one', remote: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { projectGetRemoteUrl: state.remote } }));
vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (value: { selectedProjectId: string }) => unknown) =>
    selector({ selectedProjectId: state.projectId }),
}));
vi.mock('@/stores/thread-context', () => ({ useThreadProjectId: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

describe('GitHub project remote check', () => {
  beforeEach(() => {
    state.projectId = 'one';
    state.remote.mockReset();
  });

  test('does not query a hidden tab', () => {
    render(
      <GitHubProjectGate visible={false}>
        <div>GitHub data</div>
      </GitHubProjectGate>,
    );
    expect(state.remote).not.toHaveBeenCalled();
    expect(screen.queryByText('GitHub data')).not.toBeInTheDocument();
  });

  test('keeps query children unmounted without a remote', async () => {
    state.remote.mockReturnValue(okAsync({ remoteUrl: null }));
    const query = vi.fn();
    function Queries() {
      query();
      return <div>GitHub data</div>;
    }
    render(
      <GitHubProjectGate visible>
        <Queries />
      </GitHubProjectGate>,
    );
    expect(await screen.findByTestId('github-remote-unavailable')).toHaveTextContent(
      'no GitHub remote',
    );
    expect(query).not.toHaveBeenCalled();
  });

  test('shows a real lookup failure separately from missing configuration', async () => {
    state.remote.mockReturnValue(errAsync({ message: 'Runner unavailable' }));
    render(
      <GitHubProjectGate visible>
        <div>GitHub data</div>
      </GitHubProjectGate>,
    );
    expect(await screen.findByTestId('github-remote-unavailable')).toHaveTextContent(
      'Runner unavailable',
    );
    expect(screen.queryByText('GitHub data')).not.toBeInTheDocument();
  });

  test('aborts old project checks and ignores their late responses', async () => {
    let resolve!: (value: { remoteUrl: string | null }) => void;
    state.remote.mockReturnValueOnce(
      ResultAsync.fromPromise(
        new Promise<{ remoteUrl: string | null }>((done) => {
          resolve = done;
        }),
        () => ({ message: 'failed' }),
      ),
    );
    const view = render(
      <GitHubProjectGate visible>
        <div>GitHub data</div>
      </GitHubProjectGate>,
    );
    const oldSignal = state.remote.mock.calls[0][1] as AbortSignal;
    state.projectId = 'two';
    state.remote.mockReturnValue(okAsync({ remoteUrl: null }));
    view.rerender(
      <GitHubProjectGate visible>
        <div>GitHub data</div>
      </GitHubProjectGate>,
    );
    expect(oldSignal.aborted).toBe(true);
    await screen.findByTestId('github-remote-unavailable');
    await act(async () => resolve({ remoteUrl: 'https://github.com/acme/repo' }));
    expect(screen.queryByText('GitHub data')).not.toBeInTheDocument();
  });
});
