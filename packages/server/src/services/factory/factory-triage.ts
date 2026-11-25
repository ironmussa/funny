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
 * - `too_big` with the factory's `split` setting: the server opens one issue
 *   per part (the same sanitized items, plus the parent's text for context),
 *   queues them in this factory with the run's flow, comments the list on the
 *   parent, takes the factory's label off it and ends the run `done`. A part
 *   issue is never split by itself again (`SPLIT_MARKER`): triage comments the
 *   split on it instead. Nothing opened: the split is commented as without
 *   the setting.
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
  type FactoryTriageResult,
} from '@funny/shared/contracts/factory';
import type { ActionResult, TriageOpts } from '@funny/workflows/compiler';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import type { StartedThread, StartThreadError } from '../runner-thread-launcher.js';
import type { FactoryLaunchBody, IssueRunScope } from './factory-action-provider.js';
import { issueInstruction, type FactoryIssueText } from './factory-issue-text.js';
import { contractText, launchedThread, readOnlyRoleLaunch } from './factory-review.js';
import { READ_ONLY_SHELL_RULE, readRoleResult } from './factory-role-results.js';
import { HIGH_RISK_HOLD, type UpdateRunInput } from './factory-runs.js';
import type { ThreadOutcome, WaitAfter } from './factory-thread-waits.js';

/** Why a run parked on its issue waits (shown in the run row). */
export const NEEDS_INFO_REASON = 'needs info';

/** The first line of the comment triage posts on an issue. */
export const TRIAGE_QUESTIONS_LINE =
  'The issue factory needs more information before it can work on this issue:';
export const TRIAGE_TOO_BIG_LINE =
  'The issue factory found this issue too large to work in one change. A possible split:';
export const TRIAGE_SPLIT_LINE =
  'The issue factory found this issue too large to work in one change, and opened its parts as issues:';
/**
 * Marks an issue the factory opened as a part of a split, with its parent. A
 * part is never split automatically again, so a split cannot grow by itself;
 * an issue whose author writes the marker only loses the automatic split.
 */
export const SPLIT_MARKER = 'funny-factory-split-of:';
/** The most of the parent's description a part issue carries. */
const MAX_PARENT_BODY = 20_000;
const MAX_PART_TITLE = 120;
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

/** Whether the issue is a part the factory opened in a split. */
const isSplitPart = (issue: FactoryIssueText | null): boolean =>
  issue !== null && issue.body.includes(SPLIT_MARKER);

/** Mentions turned into plain text, so copying a description pings nobody again. */
const withoutMentions = (text: string): string => text.replace(/@(?=[\w-])/g, '');

/** The title and body of an issue to open. */
interface SplitPartIssue {
  title: string;
  body: string;
}

/** The issue opened for part `index` (from 0) of `parts`, already sanitized by `publicItems`. */
export function splitPartIssue(input: {
  parent: { number: number; title: string; body: string | null };
  parts: readonly string[];
  index: number;
}): SplitPartIssue {
  const { parent, parts, index } = input;
  const part = parts[index];
  const position = `${index + 1}/${parts.length}`;
  const short = part.length > MAX_PART_TITLE ? `${part.slice(0, MAX_PART_TITLE - 1)}…` : part;
  const parentBody = withoutMentions(parent.body?.trim() ?? '');
  const context =
    parentBody.length > 0
      ? [
          `<details><summary>The description of #${parent.number}</summary>`,
          '',
          parentBody.length > MAX_PARENT_BODY
            ? `${parentBody.slice(0, MAX_PARENT_BODY)}\n\n_(cut)_`
            : parentBody,
          '',
          '</details>',
        ].join('\n')
      : null;
  return {
    title: `${short} (part ${position} of #${parent.number})`,
    body: [
      part,
      `Part ${position} of #${parent.number} (${withoutMentions(parent.title)}). The issue factory opened it when it found #${parent.number} too large for one change. Do only this part; the other parts are their own issues.`,
      ...(context ? [context] : []),
      `<!-- ${SPLIT_MARKER} #${parent.number} -->`,
    ].join('\n\n'),
  };
}

/** The comment on a split issue: the parts opened, and the ones that could not be. */
export function splitComment(parts: readonly string[], opened: readonly number[]): string {
  const missing = parts.slice(opened.length);
  return [
    TRIAGE_SPLIT_LINE,
    opened.map((number, index) => `- #${number}: ${parts[index]}`).join('\n'),
    ...(missing.length > 0
      ? [
          'These parts could not be opened; open them by hand:',
          missing.map((part) => `> - ${part}`).join('\n'),
        ]
      : []),
    '_The factory works on the parts and no longer on this issue. Close it when they are done._',
  ].join('\n\n');
}

const RESULT_FORMAT = [
  'One of these three, as a fenced json block:',
  '```json',
  '{ "decision": "ready", "contract": { "acceptanceCriteria": ["<what must be true when it is done>"], "likelyPaths": ["<glob of files the change will probably touch>"], "riskHints": ["<why it may be risky, if it is>"], "lintCleanup": false, "lintRules": [] } }',
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
    READ_ONLY_SHELL_RULE,
    // Seen in a real run: a contract without the changelog line the repository's
    // CI requires cost the implementer a CI round to find it out.
    'Also read what the repository requires of every change before it merges: its CI workflows (`.github/workflows/`), the scripts they run, and its contributing notes (`CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`). Each requirement this change must meet (a changelog line, a test next to the code, a lint or format step) is an acceptance criterion of the contract, naming the file or script that enforces it.',
    '',
    'Decide one of:',
    '- `ready`: an agent can do it without asking anyone. Write its contract: acceptance criteria someone could check against the code, the files it will probably touch (globs, at most 50), and risk hints only when the change is risky (it changes a migration, authentication, a public API, CI, or deletes data).',
    'Set `lintCleanup` to true only when the issue asks for nothing but clearing lint or type-check warnings and must not change what the code does (for example "clear rule X in package Y"). A feature, a bug fix or a refactor that also changes behavior is false, whatever it is called. When true, list in `lintRules` every rule the issue asks to clear, as the linter names it (`eslint/max-lines`, `anti-slop/no-unknown-returns`); when the issue does not name its rules, list the ones its warnings come from. The factory does not hold a lint cleanup for its size only when every rule is one whose fix cannot change behavior (splitting long functions or files, sorting imports), so name them all and add a risk hint about the size only when one of them can change behavior.',
    '- `needs_info`: something the issue must say is missing or ambiguous, and a wrong guess would waste the work. Ask at most five short questions. Do not ask what the code already answers.',
    '- `too_big`: it is several independent changes. Propose the parts.',
    'Prefer `ready` when a reasonable decision can be made and stated.',
    ...(busy ? ['', busy] : []),
    '',
    'End your final message with exactly one fenced json block, and nothing after it.',
    RESULT_FORMAT,
  ].join('\n');
}

/** What the factory's `split` setting needs: open, queue, and let go of the parent. */
export interface FactorySplitDeps {
  /** Open one issue in the run's repository; its number. */
  openIssue(issue: { title: string; body: string }): Promise<Result<number, string>>;
  /** Queue the opened parts in this factory, with the run's flow. */
  queue(issueNumbers: number[]): Promise<void>;
  /**
   * Take the factory's label off the parent, so it is not admitted again. When
   * some part could not be opened (`complete: false`), hand it to a person too.
   */
  release(complete: boolean): Promise<void>;
}

export interface FactoryTriageDeps {
  scope: IssueRunScope;
  issueUrl: string | null;
  /** What the run already stores of its triage (a resumed run, or one back from a hold). */
  stored: FactoryTriage | null;
  /** Triage threads started before this are not this attempt's. */
  since: string;
  signal: AbortSignal;
  launch(body: FactoryLaunchBody): Promise<Result<StartedThread, StartThreadError>>;
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
  /** Present when the factory opens a too-large issue's parts as issues (its `split` setting). */
  split?: FactorySplitDeps;
  /** When the issue last changed, by GitHub's clock (read after the comment); null when unreadable. */
  issueUpdatedAt?(): Promise<string | null>;
  /** The issue's text: the triage agent has no network to read it. Null when unreadable. */
  issueText?(): Promise<FactoryIssueText | null>;
  /** The likely paths of the factory's other runs in progress, by issue. */
  busyPaths?(): Promise<BusyPaths[]>;
  /** Leave the slot and wait in the queue behind `blockers` (a compare-and-set from `triaging`). */
  hold?(blockers: number[]): Promise<boolean>;
  /**
   * Run `work` (record the contract, then check the paths) alone among the
   * factory's runs, so two triages that finish together cannot both miss the
   * other's paths. Default: no exclusion.
   */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
  record(input: UpdateRunInput): Promise<void>;
  count(event: string): Promise<void>;
}

/** The parts a resumed run already opened from the same triage thread; none otherwise. */
function resumedParts(stored: FactoryTriage | null, threadId: string): number[] {
  if (stored?.decision !== 'too_big' || stored.threadId !== threadId) return [];
  return stored.splitInto ?? [];
}

/** The parent issue a part issue names: its live text when readable, else the run's title. */
function splitParent(scope: IssueRunScope, issue: FactoryIssueText | null) {
  return {
    number: scope.issueNumber,
    title: issue?.title ?? scope.issueTitle,
    body: issue?.body ?? null,
  };
}

const STOPPED: ActionResult = { ok: false, error: 'The run was stopped.' };

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
  const exclusive = deps.exclusive ?? (<T>(work: () => Promise<T>) => work());
  // A superseded answer (the issue changed since) decides nothing: triage runs again.
  let current: FactoryTriage | null = deps.stored?.superseded ? null : deps.stored;
  /** The thread of the superseded answer: never adopted as this attempt's. */
  const supersededThread = deps.stored?.superseded ? deps.stored.threadId : undefined;
  const titlePrefix = `[Factory triage] #${scope.issueNumber} `;

  /** The issue's text, read once per attempt (the prompt and the split both need it). */
  let issueRead: Promise<FactoryIssueText | null> | null = null;
  const issueText = () => (issueRead ??= deps.issueText?.() ?? Promise.resolve(null));

  async function launch(opts: TriageOpts, busyPaths: string[]): Promise<Result<string, string>> {
    const base = await deps.worktreeBase();
    if ('error' in base) return err(base.error);
    const issue = await issueText();
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

  /** Log a failed issue comment; the run goes on without it. */
  function warnIfFailed(result: Result<void, string>, message: string): void {
    if (result.isOk()) return;
    log.warn(message, {
      namespace: 'factory',
      runId: scope.runId,
      issue: scope.issueNumber,
      error: result.error,
    });
  }

  /** Ask on the issue and park the run there. Not ok: the flow stops here. */
  async function askOnIssue(
    decision: 'needs_info' | 'too_big',
    items: readonly string[],
    threadId: string,
  ): Promise<ActionResult> {
    const shown = publicItems(items);
    warnIfFailed(
      await deps.comment(triageComment(decision, items)),
      'Issue factory could not post the triage comment',
    );
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

  /**
   * Open the parts not opened yet, recording the list after each one; stops at
   * the first that cannot be opened. The parts opened, the earlier ones first.
   */
  async function openParts(
    split: FactorySplitDeps,
    shown: string[],
    threadId: string,
    issue: FactoryIssueText | null,
    at: string,
  ): Promise<number[]> {
    const opened = [...resumedParts(deps.stored, threadId)];
    const parent = splitParent(scope, issue);
    while (opened.length < shown.length) {
      const index = opened.length;
      const created = await split.openIssue(splitPartIssue({ parent, parts: shown, index }));
      if (created.isErr()) {
        log.warn('Issue factory could not open a part of a split issue', {
          namespace: 'factory',
          runId: scope.runId,
          issue: scope.issueNumber,
          part: index + 1,
          error: created.error,
        });
        break;
      }
      opened.push(created.value);
      current = { decision: 'too_big', at, threadId, items: shown, splitInto: [...opened] };
      await deps.record({ triage: current });
    }
    return opened;
  }

  /**
   * Open the parts as issues and end the run (the factory's `split` setting).
   * The issues opened so far are recorded after each one, so a resumed run
   * answering from the same thread does not open them again. Nothing opened:
   * the split is commented and the run parks, as without the setting.
   */
  async function splitIssue(
    split: FactorySplitDeps,
    parts: readonly string[],
    threadId: string,
    issue: FactoryIssueText | null,
  ): Promise<ActionResult> {
    const shown = publicItems(parts);
    const at = new Date().toISOString();
    const resumedCount = resumedParts(deps.stored, threadId).length;
    const opened = await openParts(split, shown, threadId, issue, at);
    if (opened.length === 0) return askOnIssue('too_big', parts, threadId);

    await split.queue(opened.slice(resumedCount));
    warnIfFailed(
      await deps.comment(splitComment(shown, opened)),
      'Issue factory could not comment the split on the issue',
    );
    await split.release(opened.length === shown.length);
    current = { decision: 'too_big', at, threadId, items: shown, splitInto: opened };
    await deps.record({ state: 'done', failureReason: null, triage: current });
    await deps.count('triage_too_big');
    await deps.count('triage_split');
    return {
      ok: false,
      error: `The issue was split into ${opened.map((n) => `#${n}`).join(', ')}.`,
      metadata: { outcome: 'split', decision: 'too_big', issues: opened },
    };
  }

  /** A ready run waits when its paths overlap a run in progress; null when it may go on. */
  async function heldForPaths(triage: FactoryTriage): Promise<ActionResult | null> {
    const paths = triage.contract?.likelyPaths ?? [];
    if (paths.length === 0 || !deps.busyPaths || !deps.hold) return null;
    const busy = await deps.busyPaths();
    const blockers = overlappingIssues(paths, busy);
    if (blockers.length === 0) return null;
    if (!(await deps.hold(blockers))) return null;
    await deps.count('triage_path_hold');
    const named = blockers.map((issue) => `#${issue}`).join(', ');
    return {
      ok: false,
      error: allAwaitApproval(blockers, busy)
        ? `Waiting for ${named}: it waits for a member's approval and holds the same files.`
        : `Waiting for ${named}: it works on the same files.`,
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

  /** A too-large issue: open its parts when the factory splits, else ask on it. */
  async function tooBig(parts: readonly string[], threadId: string): Promise<ActionResult> {
    const split = deps.split;
    const issue = split ? await issueText() : null;
    // A part is never split again by itself; one whose text is unreadable is not split either.
    return split && issue && !isSplitPart(issue)
      ? splitIssue(split, parts, threadId, issue)
      : askOnIssue('too_big', parts, threadId);
  }

  /** Act on triage's valid answer. */
  async function actOn(answer: FactoryTriageResult, threadId: string): Promise<ActionResult> {
    if (answer.decision === 'needs_info') {
      return askOnIssue('needs_info', answer.questions, threadId);
    }
    if (answer.decision === 'too_big') return tooBig(answer.parts, threadId);
    const ready: FactoryTriage = {
      decision: 'ready',
      at: new Date().toISOString(),
      threadId,
      contract: answer.contract,
    };
    return exclusive(async () => {
      const triage = await keep(ready);
      return (await heldForPaths(triage)) ?? proceed(triage);
    });
  }

  /** Wait for the triage thread and act on its answer. */
  async function decide(threadId: string): Promise<ActionResult> {
    const outcome = await deps.waitThread(threadId, deps.signal);
    if (deps.signal.aborted) return STOPPED;
    if (outcome.status !== 'completed') {
      return degrade(threadId, `its thread ended ${outcome.status}`);
    }
    const result = await resultOf(threadId);
    if (deps.signal.aborted) return STOPPED;
    return result.isErr() ? degrade(threadId, result.error.reason) : actOn(result.value, threadId);
  }

  return {
    /** What the run knows of its triage now. */
    current: (): FactoryTriage | null => current,

    /** The `triage` step. */
    async triage(opts: TriageOpts): Promise<ActionResult> {
      // Already decided (a resumed run, or one back from a path hold): not triaged twice.
      if (current?.decision === 'ready' || current?.decision === 'none') {
        const decided = current;
        if (decided.decision === 'ready') await deps.record({ state: 'triaging' });
        return exclusive(async () => (await heldForPaths(decided)) ?? proceed(decided));
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
 * waiting in the queue holds none; one in triage holds its paths once triage
 * gave it a contract (`triaging` with a `ready` answer, see `busyPathsOf`).
 */
const WORKING_ON_PATHS: ReadonlySet<string> = new Set([
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
]);

/**
 * How long a run parked for a member's approval keeps its paths (openspec
 * factory-merge-fewer-bounces, D6): an approval nobody gives must not block
 * its files for good.
 */
const APPROVAL_PATH_HOLD_MS = 12 * 60 * 60 * 1000;

/** A run as `busyPathsOf` reads it. */
export interface PathHolder {
  id: string;
  issueNumber: number | null;
  state: string;
  triage: FactoryTriage | null;
  stackedOn?: { runId: string } | null;
  failureReason?: string | null;
  prUrl?: string | null;
  completedAt?: string | null;
}

/** Likely paths taken by a run, by its issue; `awaitingApproval` when it is parked for one. */
export interface BusyPaths {
  issue: number;
  paths: string[];
  awaitingApproval?: true;
}

/** Parked for a member's approval of its high-risk pull request, for less than the hold. */
function awaitsApprovalAt(run: PathHolder, now: number): boolean {
  if (run.state !== 'waiting_human' || run.failureReason !== HIGH_RISK_HOLD || !run.prUrl) {
    return false;
  }
  const parked = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  return Number.isFinite(parked) && now - parked < APPROVAL_PATH_HOLD_MS;
}

/** The likely paths of the runs in progress other than `exceptRunId`, by issue. */
export function busyPathsOf(
  runs: ReadonlyArray<PathHolder>,
  exceptRunId: string,
  /**
   * The run `exceptRunId` is stacked on (D10): it builds on that run's branch
   * on purpose, so sharing its files is the point and its paths do not count.
   */
  stackedOnRunId: string | null = null,
  /**
   * Present when the factory keeps the paths of a run parked for a member's
   * approval (its `holdPathsAwaitingApproval` setting): the time to measure
   * the hold from.
   */
  approvalHold: { now: number } | null = null,
): BusyPaths[] {
  return runs.flatMap((run): BusyPaths[] => {
    // Neither way round: a blocker is not held by the runs stacked on it
    // either, since they wait for it to merge (holding it would deadlock).
    if (run.id === stackedOnRunId || run.stackedOn?.runId === exceptRunId) return [];
    // A run without an issue has no triage contract, so no likely paths.
    if (run.issueNumber === null || run.id === exceptRunId) return [];
    const held = pathsTakenBy(run, approvalHold);
    return held ? [{ issue: run.issueNumber, ...held }] : [];
  });
}

/** The paths `run` takes: while it changes files, or while it waits for an approval the factory holds them for. */
function pathsTakenBy(
  run: PathHolder,
  approvalHold: { now: number } | null,
): Omit<BusyPaths, 'issue'> | null {
  const awaitingApproval = approvalHold !== null && awaitsApprovalAt(run, approvalHold.now);
  if (!takesPaths(run.state) && !awaitingApproval) return null;
  const paths = readyPathsOf(run.triage);
  if (paths.length === 0) return null;
  return awaitingApproval ? { paths, awaitingApproval } : { paths };
}

/**
 * Whether every one of `blockers` holds its paths only because it waits for a
 * member's approval: what the run waiting for them is told.
 */
export function allAwaitApproval(blockers: readonly number[], busy: readonly BusyPaths[]): boolean {
  return (
    blockers.length > 0 &&
    blockers.every((issue) =>
      busy.some((other) => other.issue === issue && other.awaitingApproval === true),
    )
  );
}

/**
 * Triaged and going on to work: its paths are taken before it reaches
 * `working`, or a run triaged right after it would miss them.
 */
const takesPaths = (state: string): boolean => WORKING_ON_PATHS.has(state) || state === 'triaging';

/** The likely paths of a `ready` triage; none for any other answer. */
function readyPathsOf(triage: FactoryTriage | null): string[] {
  if (triage?.decision !== 'ready') return [];
  return triage.contract?.likelyPaths ?? [];
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
