/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: application-service
 * @domain layer: application
 *
 * Triage of a factory run's issue (change factory-agent-roles, D4, D5): a
 * read-only agent on its own thread reads the issue and answers whether it can
 * be worked unattended.
 *
 * - `ready`: its contract (acceptance criteria, likely paths, risk hints) is
 *   stored on the run and goes to the implementing agent and the reviewer.
 * - `needs_info` / `too_big`: the server posts ONE comment on the issue from a
 *   fixed template and parks the run in `needs_info`, where it holds no slot.
 *   The agent's words never reach GitHub as they are: at most five items of
 *   300 characters, with mentions and links removed.
 * - No valid result after one request to emit it again: the run goes on
 *   without a contract (the reviewer then judges against the issue).
 * - A ready run whose likely paths overlap those of a run in progress leaves
 *   its slot and waits in the queue, keeping its contract (a soft hold: the
 *   paths are a prediction, and the merge lane tests every change anyway).
 *
 * One issue per triage, never a batch: issue text is untrusted, and one issue
 * must not steer another's contract.
 */

import {
  factoryTriageResultSchema,
  MAX_TRIAGE_ITEM_CHARS,
  MAX_TRIAGE_ITEMS,
  type FactoryTriage,
} from '@funny/shared/contracts/factory';
import type { ActionResult, TriageOpts } from '@funny/workflows/compiler';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import type { FactoryRunScope } from './factory-action-provider.js';
import { issueInstruction, type FactoryIssueText } from './factory-issue-text.js';
import { contractText, launchedThread, readOnlyRoleLaunch } from './factory-review.js';
import { readRoleResult } from './factory-role-results.js';
import type { UpdateRunInput } from './factory-runs.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

/** Why a run parked on its issue waits (shown in the run row). */
export const NEEDS_INFO_REASON = 'needs info';

/** The first line of the comment triage posts on an issue. */
export const TRIAGE_QUESTIONS_LINE =
  'The issue factory needs more information before it can work on this issue:';
export const TRIAGE_TOO_BIG_LINE =
  'The issue factory found this issue too large to work in one change. A possible split:';
const TRIAGE_FOOTER =
  '_Edit the issue or comment here; the factory looks at it again when the issue changes._';

const WILDCARD = /[*?[{]/;

/** The part of a glob before its first wildcard. */
function staticPrefix(glob: string): string {
  const at = glob.search(WILDCARD);
  return at < 0 ? glob : glob.slice(0, at);
}

/**
 * Whether two globs may match a common path. Without wildcards: the same path,
 * or one a directory of the other. With wildcards: their static prefixes are
 * compatible. It errs toward overlap: the hold it decides is soft.
 */
export function globsOverlap(a: string, b: string): boolean {
  if (!WILDCARD.test(a) && !WILDCARD.test(b)) {
    return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  }
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

/** The issues of `others` whose paths overlap `paths`, in order, without repeats. */
export function overlappingIssues(
  paths: readonly string[],
  others: ReadonlyArray<{ issue: number; paths: readonly string[] }>,
): number[] {
  const hit = others.flatMap((other) =>
    other.paths.some((theirs) => paths.some((mine) => globsOverlap(mine, theirs)))
      ? [other.issue]
      : [],
  );
  return [...new Set(hit)];
}

/** One item as it may appear on GitHub: no mention, no link, one line, bounded. */
function publicItem(text: string): string {
  const plain = text
    // A markdown link keeps its text; a bare URL goes away.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/@(?=[\w-])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > MAX_TRIAGE_ITEM_CHARS
    ? `${plain.slice(0, MAX_TRIAGE_ITEM_CHARS - 1)}…`
    : plain;
}

/** The items triage gave, as they are posted: the first five that still say something. */
export function publicItems(items: readonly string[]): string[] {
  return items
    .flatMap((item) => {
      const shown = publicItem(item);
      return shown.length > 0 ? [shown] : [];
    })
    .slice(0, MAX_TRIAGE_ITEMS);
}

/** The issue comment: a fixed template around the sanitized items. */
export function triageComment(
  decision: 'needs_info' | 'too_big',
  items: readonly string[],
): string {
  const first = decision === 'needs_info' ? TRIAGE_QUESTIONS_LINE : TRIAGE_TOO_BIG_LINE;
  return [
    first,
    publicItems(items)
      .map((item) => `> - ${item}`)
      .join('\n'),
    TRIAGE_FOOTER,
  ].join('\n\n');
}

const RESULT_FORMAT = [
  'One of these three, as a fenced json block:',
  '```json',
  '{ "decision": "ready", "contract": { "acceptanceCriteria": ["<what must be true when it is done>"], "likelyPaths": ["<glob of files the change will probably touch>"], "riskHints": ["<why it may be risky, if it is>"] } }',
  '```',
  '```json',
  '{ "decision": "needs_info", "questions": ["<one question the issue must answer>"] }',
  '```',
  '```json',
  '{ "decision": "too_big", "parts": ["<one part that could be its own issue>"] }',
  '```',
].join('\n');

function triagePrompt(input: {
  repo: string;
  issueNumber: number;
  issueUrl: string | null;
  issue: FactoryIssueText | null;
  /** Likely paths of the factory's runs in progress. */
  busyPaths: readonly string[];
}): string {
  const busy =
    input.busyPaths.length > 0
      ? [
          'Other changes in progress touch these paths (name the same paths if this issue needs them; do not avoid them):',
          ...input.busyPaths.slice(0, 50).map((path) => `- ${path}`),
        ].join('\n')
      : null;
  return [
    'You triage a GitHub issue for an automated factory. You work unattended and only read: do not edit, commit or push anything, and do not start the work.',
    '',
    `The issue is #${input.issueNumber} of ${input.repo}${input.issueUrl ? ` (${input.issueUrl})` : ''}.`,
    issueInstruction(input.issueNumber, input.issue),
    'Then read the code it is about in the checkout.',
    '',
    'Decide one of:',
    '- `ready`: an agent can do it without asking anyone. Write its contract: acceptance criteria someone could check against the code, the files it will probably touch (globs, at most 50), and risk hints only when the change is risky (it changes a migration, authentication, a public API, CI, or deletes data).',
    '- `needs_info`: something the issue must say is missing or ambiguous, and a wrong guess would waste the work. Ask at most five short questions. Do not ask what the code already answers.',
    '- `too_big`: it is several independent changes. Propose the parts.',
    'Prefer `ready` when a reasonable decision can be made and stated.',
    ...(busy ? ['', busy] : []),
    '',
    'End your final message with exactly one fenced json block, and nothing after it.',
    RESULT_FORMAT,
  ].join('\n');
}

export interface FactoryTriageDeps {
  scope: FactoryRunScope;
  issueUrl: string | null;
  /** What the run already stores of its triage (a resumed run, or one back from a hold). */
  stored: FactoryTriage | null;
  /** Triage threads started before this are not this attempt's. */
  since: string;
  signal: AbortSignal;
  launch(body: Record<string, unknown>): Promise<Result<StartedThread, StartThreadError>>;
  /** The newest triage thread of this run whose title starts with `titlePrefix`, since `since`. */
  findLaunched(titlePrefix: string, since: string): Promise<string | null>;
  waitThread(threadId: string, signal: AbortSignal, after?: WaitAfter): Promise<ThreadOutcome>;
  finalMessage(threadId: string): Promise<string | null>;
  followUp?: {
    send(threadId: string, content: string): Promise<Result<void, string>>;
    completedAt(threadId: string): Promise<string | null>;
  };
  worktreeBase(): Promise<{ baseBranch?: string; baseFromRemote?: boolean } | { error: string }>;
  /** Post a comment on the run's issue. */
  comment(body: string): Promise<Result<void, string>>;
  /** When the issue last changed, by GitHub's clock (read after the comment); null when unreadable. */
  issueUpdatedAt?(): Promise<string | null>;
  /** The issue's text: the triage agent has no network to read it. Null when unreadable. */
  issueText?(): Promise<FactoryIssueText | null>;
  /** The likely paths of the factory's other runs in progress, by issue. */
  busyPaths?(): Promise<Array<{ issue: number; paths: string[] }>>;
  /** Leave the slot and wait in the queue behind `blockers` (a compare-and-set from `triaging`). */
  hold?(blockers: number[]): Promise<boolean>;
  record(input: UpdateRunInput): Promise<void>;
  count(event: string): Promise<void>;
}

/** The run goes on: with its contract as text, or without one. */
function proceed(triage: FactoryTriage): ActionResult {
  const contract = triage.decision === 'ready' ? triage.contract : undefined;
  return {
    ok: true,
    output: triage.decision,
    metadata: {
      decision: triage.decision,
      contract: contract ? contractText(contract) : '',
      threadId: triage.threadId,
    },
  };
}

export function createFactoryTriage(deps: FactoryTriageDeps) {
  const { scope } = deps;
  // A superseded answer (the issue changed since) decides nothing: triage runs again.
  let current: FactoryTriage | null = deps.stored?.superseded ? null : deps.stored;
  /** The thread of the superseded answer: never adopted as this attempt's. */
  const supersededThread = deps.stored?.superseded ? deps.stored.threadId : undefined;
  const titlePrefix = `[Factory triage] #${scope.issueNumber} `;

  async function launch(opts: TriageOpts, busyPaths: string[]): Promise<Result<string, string>> {
    const base = await deps.worktreeBase();
    if ('error' in base) return err(base.error);
    const issue = (await deps.issueText?.()) ?? null;
    const prompt = triagePrompt({
      repo: scope.repo,
      issueNumber: scope.issueNumber,
      issueUrl: deps.issueUrl,
      issue,
      busyPaths,
    });
    const title = `${titlePrefix}${scope.issueTitle}`;
    const body = readOnlyRoleLaunch({ scope, title, base, opts, issue, prompt });
    return launchedThread(await deps.launch(body));
  }

  /** The triage agent's validated answer, asking once more on its thread when it is invalid. */
  function resultOf(threadId: string) {
    return readRoleResult(factoryTriageResultSchema, {
      finalMessage: () => deps.finalMessage(threadId),
      askAgain: async (prompt) => {
        const followUp = deps.followUp;
        if (!followUp) return err('the triage agent cannot be asked again');
        const completedAt = await followUp.completedAt(threadId);
        const sentAt = new Date().toISOString();
        const sent = await followUp.send(threadId, prompt);
        if (sent.isErr()) return err(`the request could not be sent: ${sent.error}`);
        const outcome = await deps.waitThread(threadId, deps.signal, { completedAt, sentAt });
        if (outcome.status !== 'completed') {
          return err(`the triage agent ended ${outcome.status} when asked again`);
        }
        return ok(await deps.finalMessage(threadId));
      },
    });
  }

  /** Remember what triage decided, on the run. */
  async function keep(triage: FactoryTriage): Promise<FactoryTriage> {
    current = triage;
    await deps.record({ triage });
    await deps.count(`triage_${triage.decision}`);
    return triage;
  }

  /** Triage gave nothing usable: the run goes on without a contract. */
  async function degrade(threadId: string, why: string): Promise<ActionResult> {
    log.warn('Issue factory triage gave no contract', {
      namespace: 'factory',
      runId: scope.runId,
      threadId,
      reason: why,
    });
    return proceed(await keep({ decision: 'none', at: new Date().toISOString(), threadId }));
  }

  /** Ask on the issue and park the run there. Not ok: the flow stops here. */
  async function askOnIssue(
    decision: 'needs_info' | 'too_big',
    items: readonly string[],
    threadId: string,
  ): Promise<ActionResult> {
    const shown = publicItems(items);
    const commented = await deps.comment(triageComment(decision, items));
    if (commented.isErr()) {
      log.warn('Issue factory could not post the triage comment', {
        namespace: 'factory',
        runId: scope.runId,
        issue: scope.issueNumber,
        error: commented.error,
      });
    }
    // The baseline a later change is compared with is GitHub's own time of the
    // issue after this comment, so neither the comment nor a clock difference
    // between the server and GitHub looks like an answer.
    const at = (await deps.issueUpdatedAt?.()) ?? new Date().toISOString();
    current = { decision, at, threadId, items: shown };
    await deps.record({ state: 'needs_info', failureReason: NEEDS_INFO_REASON, triage: current });
    await deps.count(`triage_${decision}`);
    return {
      ok: false,
      error:
        decision === 'needs_info'
          ? `The issue needs more information: ${shown.join(' / ')}`
          : `The issue is too large for one change: ${shown.join(' / ')}`,
      metadata: { outcome: 'needs_info', decision },
    };
  }

  /** A ready run waits when its paths overlap a run in progress; null when it may go on. */
  async function heldForPaths(triage: FactoryTriage): Promise<ActionResult | null> {
    const paths = triage.contract?.likelyPaths ?? [];
    if (paths.length === 0 || !deps.busyPaths || !deps.hold) return null;
    const blockers = overlappingIssues(paths, await deps.busyPaths());
    if (blockers.length === 0) return null;
    if (!(await deps.hold(blockers))) return null;
    await deps.count('triage_path_hold');
    const named = blockers.map((issue) => `#${issue}`).join(', ');
    return {
      ok: false,
      error: `Waiting for ${named}: it works on the same files.`,
      metadata: { outcome: 'path_hold', blockers },
    };
  }

  /** The triage thread: one this run already launched, else a new one. */
  async function startThread(opts: TriageOpts): Promise<Result<string, string>> {
    const busy = (await deps.busyPaths?.()) ?? [];
    const found = await deps.findLaunched(titlePrefix, deps.since);
    const adopted = found && found !== supersededThread ? found : null;
    if (adopted) return ok(adopted);
    return launch(
      opts,
      busy.flatMap((other) => other.paths),
    );
  }

  /** Wait for the triage thread and act on its answer. */
  async function decide(threadId: string): Promise<ActionResult> {
    const outcome = await deps.waitThread(threadId, deps.signal);
    if (deps.signal.aborted) return { ok: false, error: 'The run was stopped.' };
    if (outcome.status !== 'completed') {
      return degrade(threadId, `its thread ended ${outcome.status}`);
    }
    const result = await resultOf(threadId);
    if (deps.signal.aborted) return { ok: false, error: 'The run was stopped.' };
    if (result.isErr()) return degrade(threadId, result.error.reason);
    const answer = result.value;
    if (answer.decision === 'needs_info')
      return askOnIssue('needs_info', answer.questions, threadId);
    if (answer.decision === 'too_big') return askOnIssue('too_big', answer.parts, threadId);
    const triage = await keep({
      decision: 'ready',
      at: new Date().toISOString(),
      threadId,
      contract: answer.contract,
    });
    return (await heldForPaths(triage)) ?? proceed(triage);
  }

  return {
    /** What the run knows of its triage now. */
    current: (): FactoryTriage | null => current,

    /** The `triage` step. */
    async triage(opts: TriageOpts): Promise<ActionResult> {
      // Already decided (a resumed run, or one back from a path hold): not triaged twice.
      if (current?.decision === 'ready' || current?.decision === 'none') {
        if (current.decision === 'ready') await deps.record({ state: 'triaging' });
        return (await heldForPaths(current)) ?? proceed(current);
      }
      const thread = await startThread(opts);
      if (thread.isErr()) {
        // Nothing ran (the runner is unreachable, say): go on without a
        // contract this time, and remember nothing, so a later attempt of the
        // run triages again.
        log.warn('Issue factory triage could not start', {
          namespace: 'factory',
          runId: scope.runId,
          error: thread.error,
        });
        return proceed({ decision: 'none', at: new Date().toISOString() });
      }
      // A triage agent is running: the run is in flight and holds its slot.
      await deps.record({ state: 'triaging' });
      return decide(thread.value);
    },
  };
}

/**
 * States in which a run is changing files: its likely paths are taken. A run
 * still in triage, or waiting in the queue, holds none.
 */
const WORKING_ON_PATHS: ReadonlySet<string> = new Set([
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
]);

/** The likely paths of the runs in progress other than `exceptRunId`, by issue. */
export function busyPathsOf(
  runs: ReadonlyArray<{
    id: string;
    issueNumber: number;
    state: string;
    triage: FactoryTriage | null;
  }>,
  exceptRunId: string,
): Array<{ issue: number; paths: string[] }> {
  return runs.flatMap((run) => {
    const paths = run.triage?.decision === 'ready' ? (run.triage.contract?.likelyPaths ?? []) : [];
    return run.id !== exceptRunId && paths.length > 0 && WORKING_ON_PATHS.has(run.state)
      ? [{ issue: run.issueNumber, paths }]
      : [];
  });
}

/**
 * Whether a `needs_info` run should be triaged again: its issue changed after
 * triage asked (an edit or a comment moves GitHub's `updated_at`).
 */
export function issueChangedSince(triage: FactoryTriage | null, updatedAt: string | undefined) {
  if (!triage || !updatedAt) return false;
  const changed = Date.parse(updatedAt);
  const asked = Date.parse(triage.at);
  return Number.isFinite(changed) && Number.isFinite(asked) && changed > asked;
}
