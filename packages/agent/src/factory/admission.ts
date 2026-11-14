/**
 * Which ready issues a factory run starts for (#284). An issue is admitted when
 * it is open, carries the ready label, was opened by the configured login, is
 * assigned to that login or to nobody, has no open blocker by GitHub's native
 * issue dependencies, and has no active factory run; oldest first, within the
 * concurrency limit and the daily limit on new runs.
 *
 * Each watched repository gets its missing labels created once, and is given
 * at most `admissionTimeoutMs` per tick, so one slow repository does not hold
 * up the others. A repository where the Factory App is not installed is
 * reported in the log and in `status`.
 */

import { blocksAdmission } from '../domain/factory-run.js';
import type { IssueSourceError, ReadyIssue } from '../ports/issue-source.js';
import type { FactoryProject } from '../settings/schema.js';
import type { FactoryContext } from './context.js';

const NOT_INSTALLED =
  'the Factory App is not installed on this repository; install it there to have its issues worked on';

/** How long one repository's admission may take per tick, by default. */
const ADMISSION_TIMEOUT_MS = 60_000;

/** `work`, or nothing once `ms` have passed (the work is abandoned, not cancelled). */
function within(ms: number, work: Promise<void>): Promise<'done' | 'timed out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timed out'>((resolve) => {
    timer = setTimeout(() => resolve('timed out'), ms);
  });
  return Promise.race([work.then(() => 'done' as const), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

export function createAdmission(
  ctx: FactoryContext,
  startRun: (project: FactoryProject, issue: ReadyIssue) => void,
  options: { timeoutMs?: number } = {},
) {
  const { settings, store, log } = ctx;
  const login = settings.github.login.toLowerCase();
  const labelled = new Set<string>();
  const today = () => ctx.clock.now().toISOString().slice(0, 10);

  const onRepoError = (repo: string, error: IssueSourceError) => {
    if (error.kind === 'not-installed') {
      store.setRepoNotice(repo, NOT_INSTALLED);
      log.warn(`${repo}: ${NOT_INSTALLED}`);
      return;
    }
    log.warn('Could not look for ready issues', { repo, error: error.message });
  };

  /** Opened by the login, assigned to it or to nobody, with no active factory run. */
  const eligible = (repo: string, issue: ReadyIssue) =>
    issue.author.toLowerCase() === login &&
    issue.assignees.every((a) => a.toLowerCase() === login) &&
    !store
      .list()
      .some((r) => r.repo === repo && r.issueNumber === issue.number && blocksAdmission(r));

  const room = () => ctx.slotsLeft() > 0 && settings.limits.daily - store.startedOn(today()) > 0;

  /** Create the labels a repository lacks, once per process; false when GitHub refused. */
  async function labelsReady(repo: string): Promise<boolean> {
    if (labelled.has(repo)) return true;
    const labels = [settings.labels.ready, settings.labels.in_progress];
    const ensured = await ctx.issues.ensureLabels(repo, labels);
    if (ensured.isOk()) {
      labelled.add(repo);
      return true;
    }
    onRepoError(repo, ensured.error);
    // Labels the App may not create (a 403) do not stop admission; an App
    // that is not installed does.
    return ensured.error.kind !== 'not-installed';
  }

  /** Start a factory run for `issue` if nothing blocks it (its blockers are read last: one call each). */
  async function consider(project: FactoryProject, issue: ReadyIssue): Promise<void> {
    if (!eligible(project.repo, issue)) return;
    const blockers = await ctx.issues.openBlockers(project.repo, issue.number);
    if (blockers.isErr()) {
      log.warn('Could not read the blockers of an issue', {
        repo: project.repo,
        issue: issue.number,
      });
      return;
    }
    // Blocked: it waits, and is admitted on a tick after its blockers close. The
    // blockers were read asynchronously: room and eligibility are checked again.
    if (blockers.value.length === 0 && room() && eligible(project.repo, issue)) {
      startRun(project, issue);
    }
  }

  async function admitProject(project: FactoryProject): Promise<void> {
    if (!(await labelsReady(project.repo))) return;
    const ready = await ctx.issues.listReady(project.repo, settings.labels.ready);
    if (ready.isErr()) return onRepoError(project.repo, ready.error);
    store.setRepoNotice(project.repo, null);
    for (const issue of ready.value) {
      if (!room()) return;
      await consider(project, issue);
    }
  }

  return async function admit(projects: FactoryProject[]): Promise<void> {
    // Notices about repositories no longer watched go.
    for (const { repo } of store.repoNotices()) {
      if (!projects.some((p) => p.repo === repo)) store.setRepoNotice(repo, null);
    }
    for (const project of projects) {
      const outcome = await within(
        options.timeoutMs ?? ADMISSION_TIMEOUT_MS,
        admitProject(project),
      );
      if (outcome === 'timed out') {
        log.warn('Looking for ready issues timed out', { repo: project.repo });
      }
    }
  };
}
