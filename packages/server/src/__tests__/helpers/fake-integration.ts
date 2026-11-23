/**
 * An in-memory host for the factory's merge queue (`IntegrationProvider`): a
 * commit is the set of pull request heads merged into it, so a test decides
 * a commit's CI from what it contains (a culprit, two members that clash, a
 * flake). Records every merge and with whose token it was made.
 */
import type { CiState, IntegrationProvider, MergeRefResult } from '@funny/core/github-app';
import { okAsync } from 'neverthrow';

export interface FakeHostOptions {
  /** CI of a commit by its content (the merged heads, sorted); default green. */
  ci?(content: string[], times: number): 'green' | 'red' | 'none' | 'pending';
  /** Heads that do not merge onto anything but the bare base. */
  conflicts?: Set<string>;
  /** Pull request numbers whose merge GitHub refuses. */
  refuse?: Set<number>;
  /** Called after each CI look (a test moves the base or a head there). */
  afterCheck?(host: FakeHost): void;
}

export interface FakeHost {
  /** The provider with `userId`'s token. */
  as(userId: string): IntegrationProvider;
  branches: Map<string, string>;
  /** Pull request number → its head. */
  heads: Map<number, string>;
  /** Merges of pull requests, in order, with whose token. */
  merged: Array<{ number: number; sha: string; userId: string }>;
  /** Commit messages of the merges onto staging branches. */
  stagingMessages: string[];
  /** The distinct commits CI was asked about. */
  checked: Set<string>;
  /** Push a commit with `head` onto branch `name` (someone else's merge). */
  push(name: string, head: string): void;
  contentOf(sha: string): string[];
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const commits = new Map<string, string[]>([['B0', []]]);
  const branches = new Map<string, string>([['main', 'B0']]);
  const heads = new Map<number, string>();
  const merged: FakeHost['merged'] = [];
  const stagingMessages: string[] = [];
  const checked = new Set<string>();
  const looks = new Map<string, number>();
  let next = 0;
  const commit = (content: string[]) => {
    const sha = `c${++next}`;
    commits.set(sha, [...new Set(content)].sort());
    return sha;
  };
  const contentOf = (sha: string) => commits.get(sha) ?? [];
  const host: FakeHost = {
    branches,
    heads,
    merged,
    stagingMessages,
    checked,
    contentOf,
    push(name, head) {
      branches.set(name, commit([...contentOf(branches.get(name)!), head]));
    },
    as(userId) {
      const provider: IntegrationProvider = {
        branchRules: () => okAsync({ mergeQueue: false, requiredChecks: [], upToDate: null }),
        branchHead: (_repo, branch) => okAsync(branches.get(branch) ?? 'B0'),
        setBranch(_repo, name, sha) {
          branches.set(name, sha);
          return okAsync(undefined);
        },
        mergeRefInto(_repo, branch, ref, message) {
          stagingMessages.push(message);
          const into = contentOf(branches.get(branch)!);
          if (into.includes(ref)) return okAsync<MergeRefResult>({ kind: 'up-to-date' });
          const onBase = into.every((h) => contentOf(branches.get('main')!).includes(h));
          if (options.conflicts?.has(ref) && !onBase)
            return okAsync<MergeRefResult>({ kind: 'conflict' });
          const sha = commit([...into, ref]);
          branches.set(branch, sha);
          return okAsync<MergeRefResult>({ kind: 'merged', sha });
        },
        sameTreeCommit: (_repo, sha) => okAsync(commit(contentOf(sha))),
        treeOf: (_repo, sha) => okAsync(contentOf(sha).join(',')),
        checks(_repo, sha) {
          checked.add(sha);
          const content = contentOf(sha).join(',');
          const times = (looks.get(content) ?? 0) + 1;
          looks.set(content, times);
          const verdict = options.ci?.(contentOf(sha), times) ?? 'green';
          options.afterCheck?.(host);
          const states: Record<typeof verdict, CiState> = {
            green: { kind: 'green' },
            none: { kind: 'none' },
            pending: { kind: 'pending' },
            red: {
              kind: 'failing',
              checks: [{ name: 'test', conclusion: 'failure', excerpt: `red with ${content}` }],
              sha,
            },
          };
          return okAsync(states[verdict]);
        },
        checkNames: () => okAsync(['test']),
        mergePullRequest(_repo, number, { sha }) {
          if (options.refuse?.has(number)) {
            return okAsync({
              kind: 'refused' as const,
              reason: 'Base branch was modified',
              status: 405,
            });
          }
          if (heads.get(number) !== sha) {
            return okAsync({
              kind: 'refused' as const,
              reason: 'Head branch was modified',
              status: 409,
            });
          }
          host.push('main', sha);
          const landed = branches.get('main')!;
          merged.push({ number, sha: landed, userId });
          return okAsync({ kind: 'merged' as const, sha: landed });
        },
        pullRequestMergeability: (_repo, number) =>
          okAsync({
            state: merged.some((m) => m.number === number)
              ? ('merged' as const)
              : ('open' as const),
            headSha: heads.get(number) ?? '',
            mergeable: true,
          }),
        enqueueInHostQueue: () => okAsync({ kind: 'queued' as const }),
        deleteBranch(_repo, branch) {
          branches.delete(branch);
          return okAsync(undefined);
        },
      };
      return provider;
    },
  };
  return host;
}
