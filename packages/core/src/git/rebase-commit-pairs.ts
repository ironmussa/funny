import type { GitRebaseCommitPair, GitRebaseReflogEvent } from './log.js';
import { execute, gitRead } from './process.js';
import { cachedRebasePairs, type RebasePairsComputation } from './rebase-pairs-cache.js';

interface PatchCandidate {
  hash: string;
  shortHash: string;
  subject: string;
}

/**
 * Pair each commit a rebase replayed with the commit it was copied from, by
 * stable patch id and then by subject. The graph draws these pairs as copy
 * links, so they are needed on every load; the cache keeps them per repository
 * until a new rebase reaches the reflog.
 */
export async function enrichRebaseEventsWithCommitPairs(
  cwd: string,
  events: GitRebaseReflogEvent[],
  candidateLimit: number,
): Promise<GitRebaseReflogEvent[]> {
  if (events.length === 0) return events;
  const pairsByEvent = await cachedRebasePairs(cwd, events, candidateLimit, () =>
    computeRebaseCommitPairs(cwd, events, candidateLimit),
  );
  return events.map((event, index) => ({ ...event, commitPairs: pairsByEvent[index] ?? [] }));
}

async function computeRebaseCommitPairs(
  cwd: string,
  events: GitRebaseReflogEvent[],
  candidateLimit: number,
): Promise<RebasePairsComputation> {
  const eventHashes = new Set(events.flatMap((event) => event.commitHashes));
  const replayedSubjects = new Set(
    events.flatMap((event) =>
      event.steps
        .filter((step) => step.action === 'pick' || step.action === 'continue')
        .map((step) => normalizeSubject(step.message)),
    ),
  );
  const candidates = await getRebasePatchCandidates(cwd, Math.max(candidateLimit, 500));
  const relevantCandidates = (candidates ?? []).filter(
    (candidate) =>
      eventHashes.has(candidate.hash) || replayedSubjects.has(normalizeSubject(candidate.subject)),
  );
  const candidateByHash = new Map(
    relevantCandidates.map((candidate) => [candidate.hash, candidate]),
  );
  const hashesToFingerprint = new Set<string>([
    ...relevantCandidates.map((candidate) => candidate.hash),
    ...eventHashes,
  ]);
  const patchIds = await getStablePatchIds(cwd, [...hashesToFingerprint]);
  const patchIdsByHash = patchIds ?? new Map<string, string>();
  const candidatesByPatchId = new Map<string, PatchCandidate[]>();
  const candidatesBySubject = new Map<string, PatchCandidate[]>();
  for (const candidate of relevantCandidates) {
    const subjectKey = normalizeSubject(candidate.subject);
    const subjectMatches = candidatesBySubject.get(subjectKey);
    if (subjectMatches) subjectMatches.push(candidate);
    else candidatesBySubject.set(subjectKey, [candidate]);

    const patchId = patchIdsByHash.get(candidate.hash);
    if (!patchId) continue;
    const existing = candidatesByPatchId.get(patchId);
    if (existing) existing.push(candidate);
    else candidatesByPatchId.set(patchId, [candidate]);
  }

  return {
    complete: candidates !== null && patchIds !== null,
    pairsByEvent: events.map((event) =>
      inferCommitPairsForEvent(
        event,
        patchIdsByHash,
        candidatesByPatchId,
        candidatesBySubject,
        candidateByHash,
      ),
    ),
  };
}

/** Commits that may be the originals of rebased ones; `null` when git failed. */
async function getRebasePatchCandidates(
  cwd: string,
  limit: number,
): Promise<PatchCandidate[] | null> {
  const FIELD_SEP = '\x1f';
  const result = await gitRead(
    ['log', '--all', '--reflog', `--format=%H${FIELD_SEP}%h${FIELD_SEP}%s`, '-n', String(limit)],
    { cwd, reject: false },
  );
  if (result.exitCode !== 0) return null;
  if (!result.stdout.trim()) return [];
  const byHash = new Map<string, PatchCandidate>();
  for (const line of result.stdout.split('\n')) {
    const [hash, shortHash, subject] = line.split(FIELD_SEP);
    if (!hash || byHash.has(hash)) continue;
    byHash.set(hash, { hash, shortHash, subject });
  }
  return [...byHash.values()];
}

/** Stable patch id per commit hash; `null` when git failed. */
async function getStablePatchIds(
  cwd: string,
  hashes: string[],
): Promise<Map<string, string> | null> {
  if (hashes.length === 0) return new Map();
  const result = await gitRead(['show', '--pretty=format:commit %H', '--patch', ...hashes], {
    cwd,
    reject: false,
    maxOutputBytes: 20 * 1024 * 1024,
  });
  if (result.exitCode !== 0) return null;
  if (!result.stdout.trim()) return new Map();
  const patchIdResult = await execute('git', ['patch-id', '--stable'], {
    cwd,
    stdin: result.stdout,
    reject: false,
    maxOutputBytes: 5 * 1024 * 1024,
  });
  if (patchIdResult.exitCode !== 0) return null;

  const byHash = new Map<string, string>();
  for (const line of patchIdResult.stdout.split('\n')) {
    const [patchId, hash] = line.trim().split(/\s+/);
    if (patchId && hash) byHash.set(hash, patchId);
  }
  return byHash;
}

/** A commit the rebase replayed: an actual step, or a bare rewritten hash. */
interface ReplayedCommit {
  hash: string;
  shortHash: string;
  message: string;
}

/**
 * The steps a rebase replayed. Falls back to the event's rewritten hashes when
 * the reflog recorded no pick/continue steps (e.g. an autosquash summary).
 */
function resolveReplayedCommits(
  event: GitRebaseReflogEvent,
  candidateByHash: Map<string, PatchCandidate>,
): ReplayedCommit[] {
  const replayedSteps = event.steps.filter(
    (step) => step.action === 'pick' || step.action === 'continue',
  );
  if (replayedSteps.length > 0) return replayedSteps;
  return event.commitHashes.map((hash) => ({
    hash,
    shortHash: candidateByHash.get(hash)?.shortHash ?? hash.slice(0, 7),
    message: candidateByHash.get(hash)?.subject ?? '',
  }));
}

/** The commit a replayed step was copied from: by stable patch id, else subject. */
function findOriginalForStep(
  step: ReplayedCommit,
  patchIdsByHash: Map<string, string>,
  candidatesByPatchId: Map<string, PatchCandidate[]>,
  candidatesBySubject: Map<string, PatchCandidate[]>,
  rewrittenHashes: Set<string>,
): PatchCandidate | null {
  const patchId = patchIdsByHash.get(step.hash);
  const byPatchId = patchId
    ? selectOriginalCandidate(
        candidatesByPatchId.get(patchId) ?? [],
        step.hash,
        step.message,
        rewrittenHashes,
      )
    : null;
  return (
    byPatchId ??
    selectOriginalCandidate(
      candidatesBySubject.get(normalizeSubject(step.message)) ?? [],
      step.hash,
      step.message,
      rewrittenHashes,
    )
  );
}

function inferCommitPairsForEvent(
  event: GitRebaseReflogEvent,
  patchIdsByHash: Map<string, string>,
  candidatesByPatchId: Map<string, PatchCandidate[]>,
  candidatesBySubject: Map<string, PatchCandidate[]>,
  candidateByHash: Map<string, PatchCandidate>,
): GitRebaseCommitPair[] {
  const rewrittenHashes = new Set(event.commitHashes);
  const replayed = resolveReplayedCommits(event, candidateByHash);
  const pairs: GitRebaseCommitPair[] = [];
  const seen = new Set<string>();

  for (const step of replayed) {
    const original = findOriginalForStep(
      step,
      patchIdsByHash,
      candidatesByPatchId,
      candidatesBySubject,
      rewrittenHashes,
    );
    if (!original) continue;
    const key = `${original.hash}->${step.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      originalHash: original.hash,
      originalShortHash: original.shortHash,
      rebasedHash: step.hash,
      rebasedShortHash: step.shortHash,
      subject: step.message || original.subject,
    });
  }

  return pairs;
}

function selectOriginalCandidate(
  candidates: PatchCandidate[],
  rebasedHash: string,
  subject: string,
  rewrittenHashes: Set<string>,
): PatchCandidate | null {
  const pool = candidates.filter(
    (candidate) => candidate.hash !== rebasedHash && !rewrittenHashes.has(candidate.hash),
  );
  if (pool.length === 0) return null;
  return (
    pool.find((candidate) => normalizeSubject(candidate.subject) === normalizeSubject(subject)) ??
    pool[0]
  );
}

function normalizeSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, ' ');
}
