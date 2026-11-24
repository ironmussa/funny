#!/usr/bin/env bun
/**
 * Summarizes worktree preparation timings stored in Abbacchio.
 *
 *   bun run profile:worktree-setup                      # last 7 days
 *   bun run profile:worktree-setup -- --days 30
 *   bun run profile:worktree-setup -- --thread <threadId>
 *
 * Reads the `worktree.prepare` spans (one per preparation) and their
 * `worktree.setup.step` children, recorded by
 * packages/runtime/src/services/thread-service/worktree-preparation.ts.
 * Splitting by `worktree.root_configured` shows what FUNNY_WORKTREE_ROOT buys.
 *
 * Uses fetch rather than curl on purpose: the rtk shell hook truncates curl
 * output, which corrupts JSON responses.
 */

const ENDPOINT = process.env.OTLP_ENDPOINT || 'http://localhost:4000';

type Row = Record<string, string | number | null>;

async function sql(query: string): Promise<Row[]> {
  const res = await fetch(`${ENDPOINT}/api/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: query }),
  });
  if (!res.ok) throw new Error(`Abbacchio ${res.status}: ${await res.text()}`);
  const body: { rows?: Row[]; error?: string } = await res.json();
  if (body.error) throw new Error(body.error);
  return body.rows ?? [];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Only ids made of safe characters reach the SQL text. */
function safeId(value: string): string {
  if (!/^[\w-]+$/.test(value)) throw new Error(`Invalid id: ${value}`);
  return value;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function seconds(ms: unknown): string {
  return isNumber(ms) ? `${(ms / 1000).toFixed(1)}s` : '—';
}

/** SQL filter for the runs to read: one thread, or the last N days. */
function runScope(): string {
  const thread = arg('--thread');
  if (thread) return `json_extract(attributes, '$."thread.id"') = '${safeId(thread)}'`;
  const days = Number(arg('--days') ?? 7);
  return `start_time_ms >= ${Date.now() - days * 24 * 60 * 60 * 1000}`;
}

function readRuns(scope: string): Promise<Row[]> {
  return sql(`
    SELECT trace_id,
           datetime(start_time_ms / 1000, 'unixepoch') AS started,
           json_extract(attributes, '$."thread.id"') AS thread_id,
           json_extract(attributes, '$.flow') AS flow,
           json_extract(attributes, '$.outcome') AS outcome,
           json_extract(attributes, '$."worktree.root_configured"') AS root_configured,
           end_time_ms - start_time_ms AS total_ms,
           json_extract(attributes, '$."create.ms"') AS create_ms,
           json_extract(attributes, '$."post_create.ms"') AS post_create_ms
    FROM traces
    WHERE name = 'worktree.prepare' AND channel = 'funny-runtime' AND ${scope}
    ORDER BY start_time_ms DESC
    LIMIT 50`);
}

function printRuns(runs: Row[]): void {
  console.log(`Worktree preparations (${runs.length}, newest first)\n`);
  for (const r of runs) {
    const root = r.root_configured ? 'yes' : 'no ';
    console.log(
      `${r.started}  ${String(r.thread_id).padEnd(22)} ${String(r.flow).padEnd(10)} ` +
        `${String(r.outcome).padEnd(13)} root=${root} total=${seconds(r.total_ms)} ` +
        `checkout=${seconds(r.create_ms)} setup=${seconds(r.post_create_ms)}`,
    );
  }
}

async function printSteps(traceIds: string): Promise<void> {
  const steps = await sql(`
    SELECT json_extract(attributes, '$.step') AS step,
           COUNT(*) AS runs,
           ROUND(AVG(end_time_ms - start_time_ms)) AS avg_ms,
           MAX(end_time_ms - start_time_ms) AS max_ms,
           SUM(json_extract(attributes, '$.status') != 'completed') AS not_completed
    FROM traces
    WHERE name = 'worktree.setup.step' AND trace_id IN (${traceIds})
    GROUP BY step
    ORDER BY avg_ms DESC`);
  console.log('\nSteps, slowest on average first\n');
  for (const s of steps) {
    const failures = Number(s.not_completed) > 0 ? `  (${s.not_completed} not completed)` : '';
    console.log(
      `${String(s.step).padEnd(40)} avg=${seconds(s.avg_ms)} max=${seconds(s.max_ms)} ` +
        `runs=${s.runs}${failures}`,
    );
  }
}

async function printRootComparison(traceIds: string): Promise<void> {
  const byRoot = await sql(`
    SELECT json_extract(attributes, '$."worktree.root_configured"') AS root_configured,
           COUNT(*) AS runs,
           ROUND(AVG(end_time_ms - start_time_ms)) AS avg_ms
    FROM traces
    WHERE trace_id IN (${traceIds}) AND name = 'worktree.prepare'
      AND json_extract(attributes, '$.outcome') = 'ok'
    GROUP BY root_configured`);
  if (byRoot.length < 2) return;
  console.log('\nFUNNY_WORKTREE_ROOT');
  for (const b of byRoot) {
    const label = b.root_configured ? 'set  ' : 'unset';
    console.log(`  ${label}  avg=${seconds(b.avg_ms)} runs=${b.runs}`);
  }
}

async function main(): Promise<void> {
  const runs = await readRuns(runScope());
  if (runs.length === 0) {
    console.log(
      'No worktree.prepare spans found. Create a worktree thread on a runner running ' +
        'this code, then run the script again.',
    );
    return;
  }
  printRuns(runs);
  const traceIds = runs.map((r) => `'${safeId(String(r.trace_id))}'`).join(',');
  await printSteps(traceIds);
  await printRootComparison(traceIds);
}

await main();
