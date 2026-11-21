import { describe, test, expect, vi, beforeEach, afterEach, mock } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// bun's mock.module reads a getter once, so each test re-mocks DATA_DIR with its
// own directory (a repeated mock.module call updates the live binding).
function mockDataDir(path: string): void {
  mock.module('../../lib/data-dir.js', () => ({ DATA_DIR: path }));
}
mockDataDir(join(tmpdir(), 'funny-staging-unset'));

mock.module('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

mock.module('../../utils/route-helpers.js', () => ({ requireThreadCwd: vi.fn() }));

// Imported after the mocks, so the module binds the mocked DATA_DIR getter.
const { adoptStagedUploads, copyThreadUploads, releaseStagedUploads, stageUpload } =
  await import('../../services/thread-service/staged-uploads.js');

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('staged uploads', () => {
  let dataPath: string;
  let cwd: string;
  beforeEach(() => {
    dataPath = mkdtempSync(join(tmpdir(), 'funny-staging-data-'));
    cwd = mkdtempSync(join(tmpdir(), 'funny-staging-cwd-'));
    mockDataDir(dataPath);
  });

  afterEach(() => {
    rmSync(dataPath, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const stage = async (userId: string, filename: string, text = 'pdf bytes') =>
    (
      await stageUpload({ userId, provider: 'claude', filename, contentBase64: b64(text) })
    )._unsafeUnwrap();

  test('parks the file in the per-user staging area with a sanitized name', async () => {
    const staged = await stage('u-1', '../my report.pdf');

    expect(staged.name).toBe('my_report.pdf');
    const file = join(dataPath, 'uploads-staging', 'u-1', staged.stagedId, 'my_report.pdf');
    expect(readFileSync(file, 'utf-8')).toBe('pdf bytes');
  });

  test('adopts staged files into the thread uploads dir, keeping the entry until released', async () => {
    const staged = await stage('u-1', 'spec.pdf');

    const refs = (
      await adoptStagedUploads({
        userId: 'u-1',
        stagedIds: [staged.stagedId],
        cwd,
        threadId: 't-1',
      })
    )._unsafeUnwrap();

    expect(refs).toEqual([{ path: join('.funny', 'uploads', 't-1', 'spec.pdf') }]);
    expect(readFileSync(join(cwd, refs[0].path), 'utf-8')).toBe('pdf bytes');
    expect(readFileSync(join(cwd, '.funny', '.gitignore'), 'utf-8')).toContain('*');
    const entry = join(dataPath, 'uploads-staging', 'u-1', staged.stagedId);
    expect(existsSync(entry)).toBe(true);

    (await releaseStagedUploads('u-1', [staged.stagedId]))._unsafeUnwrap();
    expect(existsSync(entry)).toBe(false);
  });

  test('a failed request can retry with the same staged id', async () => {
    const staged = await stage('u-1', 'spec.pdf');
    const adopt = (threadId: string) =>
      adoptStagedUploads({ userId: 'u-1', stagedIds: [staged.stagedId], cwd, threadId });

    // First attempt adopted the file but the request failed afterwards (no release).
    (await adopt('t-1'))._unsafeUnwrap();
    const retry = (await adopt('t-2'))._unsafeUnwrap();

    expect(readFileSync(join(cwd, retry[0].path), 'utf-8')).toBe('pdf bytes');
  });

  test("refuses another user's staged file and adopts nothing", async () => {
    const mine = await stage('u-1', 'a.pdf');
    const theirs = await stage('u-2', 'b.pdf');

    const result = await adoptStagedUploads({
      userId: 'u-1',
      stagedIds: [mine.stagedId, theirs.stagedId],
      cwd,
      threadId: 't-1',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().type).toBe('BAD_REQUEST');
    // Validation runs before any move: the user's own file is still staged.
    expect(existsSync(join(dataPath, 'uploads-staging', 'u-1', mine.stagedId, 'a.pdf'))).toBe(true);
    expect(existsSync(join(cwd, '.funny'))).toBe(false);
  });

  test('refuses ids that are not staging uuids', async () => {
    const result = await adoptStagedUploads({
      userId: 'u-1',
      stagedIds: ['../../etc'],
      cwd,
      threadId: 't-1',
    });
    expect(result._unsafeUnwrapErr().type).toBe('BAD_REQUEST');
  });

  test('rejects user ids that are not plain ids', async () => {
    const result = await stageUpload({
      userId: '../escape',
      provider: 'claude',
      filename: 'a.txt',
      contentBase64: b64('x'),
    });
    expect(result.isErr()).toBe(true);
  });

  test('prunes expired entries on the next stage call', async () => {
    const root = join(dataPath, 'uploads-staging', 'u-1');
    const old = join(root, 'old-entry');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'x.pdf'), 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(old, twoDaysAgo, twoDaysAgo);

    const fresh = await stage('u-1', 'new.pdf');

    expect(readdirSync(root)).toEqual([fresh.stagedId]);
  });

  test('copies a thread uploads dir into another checkout', async () => {
    const staged = await stage('u-1', 'spec.pdf');
    await adoptStagedUploads({ userId: 'u-1', stagedIds: [staged.stagedId], cwd, threadId: 't-1' });
    const worktree = mkdtempSync(join(tmpdir(), 'funny-staging-wt-'));

    try {
      (await copyThreadUploads(cwd, worktree, 't-1'))._unsafeUnwrap();
      expect(readFileSync(join(worktree, '.funny', 'uploads', 't-1', 'spec.pdf'), 'utf-8')).toBe(
        'pdf bytes',
      );
    } finally {
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
