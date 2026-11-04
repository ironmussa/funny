/**
 * Viewport recorder: frames are encoded into an MP4, and a recording in
 * progress survives the startup cleanup of legacy `funny-browser-*` temp
 * profiles (it used to share that prefix and lost its frames mid-recording).
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));

import { hasFfmpeg, ViewportRecorder } from '../../services/browser-automation/recorder.js';
import { browserSessionManager } from '../../services/browser-session-manager.js';

const outDir = mkdtempSync(join(tmpdir(), 'funny-recorder-test-'));
const ffmpeg = await hasFfmpeg();

function jpeg(color: string): string {
  return execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=${color}:s=320x240`,
    '-frames:v',
    '1',
    '-f',
    'mjpeg',
    'pipe:1',
  ]).toString('base64');
}

describe.skipIf(!ffmpeg)('ViewportRecorder', () => {
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  test('a recording survives the legacy temp-profile cleanup', async () => {
    const recorder = await ViewportRecorder.start();
    recorder.addFrame(jpeg('red'), 1);
    await browserSessionManager.cleanupLegacyTempProfiles();
    recorder.addFrame(jpeg('blue'), 1.5);

    const result = await recorder.stop(join(outDir, 'out.mp4'));
    expect(result._unsafeUnwrap()).toMatchObject({ frames: 2, seconds: 2 });
    expect(existsSync(join(outDir, 'out.mp4'))).toBe(true);
  });

  test('stopping without frames is an error', async () => {
    const recorder = await ViewportRecorder.start();
    const result = await recorder.stop(join(outDir, 'empty.mp4'));
    expect(result._unsafeUnwrapErr().message).toBe('No frames were captured.');
  });
});
