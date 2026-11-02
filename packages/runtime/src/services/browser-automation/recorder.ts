/**
 * Viewport recording for a browser session.
 *
 * Reuses the panel's screencast frames (already flowing for every session)
 * instead of Playwright's `recordVideo`, which only works for contexts it
 * creates. Frames arrive only when the page repaints, so each one is kept with
 * its timestamp and encoded at variable frame rate with ffmpeg's concat
 * demuxer.
 */

import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { ResultAsync } from 'neverthrow';

const execFileAsync = promisify(execFile);

/** Hard caps so a forgotten recording cannot fill the disk. */
const MAX_FRAMES = 6_000;
const MAX_DURATION_MS = 10 * 60_000;
/** How long the last frame stays on screen. */
const LAST_FRAME_SECONDS = 1;

let ffmpegAvailable: Promise<boolean> | null = null;

/** Whether an ffmpeg with libx264 is on PATH (checked once per process). */
export function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= execFileAsync('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10_000 })
    .then(({ stdout }) => stdout.includes('libx264'))
    .catch(() => false);
  return ffmpegAvailable;
}

interface RecordedFrame {
  file: string;
  /** Seconds, as reported by CDP `screencastFrame` metadata. */
  timestamp: number;
}

export class ViewportRecorder {
  private frames: RecordedFrame[] = [];
  private writes: Promise<void>[] = [];
  readonly startedAt = Date.now();

  private constructor(private readonly dir: string) {}

  static async start(): Promise<ViewportRecorder> {
    // Not `funny-browser-*`: startup cleanup of legacy temp profiles removes those.
    return new ViewportRecorder(await mkdtemp(join(tmpdir(), 'funny-recording-')));
  }

  /** True once the caps are reached; later frames are dropped. */
  get full(): boolean {
    return this.frames.length >= MAX_FRAMES || Date.now() - this.startedAt > MAX_DURATION_MS;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  addFrame(base64Jpeg: string, timestamp: number): void {
    if (this.full) return;
    const file = join(this.dir, `frame-${String(this.frames.length).padStart(6, '0')}.jpg`);
    this.frames.push({ file, timestamp });
    this.writes.push(writeFile(file, Buffer.from(base64Jpeg, 'base64')).catch(() => {}));
  }

  /** ffmpeg concat-demuxer script: each frame shown until the next one arrived. */
  private concatScript(): string {
    const lines: string[] = [];
    this.frames.forEach((frame, i) => {
      const next = this.frames[i + 1];
      const duration = next ? Math.max(next.timestamp - frame.timestamp, 0.01) : LAST_FRAME_SECONDS;
      lines.push(`file '${frame.file}'`, `duration ${duration.toFixed(3)}`);
    });
    // The concat demuxer ignores the last duration unless the file repeats.
    const last = this.frames.at(-1);
    if (last) lines.push(`file '${last.file}'`);
    return lines.join('\n');
  }

  /** Encode to MP4 at `outputPath` and remove the frames. */
  stop(outputPath: string): ResultAsync<{ path: string; frames: number; seconds: number }, Error> {
    return ResultAsync.fromPromise(
      (async () => {
        try {
          if (this.frames.length === 0) throw new Error('No frames were captured.');
          await Promise.all(this.writes);
          const list = join(this.dir, 'frames.txt');
          await writeFile(list, this.concatScript());
          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-f',
              'concat',
              '-safe',
              '0',
              '-i',
              list,
              '-vf',
              'scale=trunc(iw/2)*2:trunc(ih/2)*2',
              '-fps_mode',
              'vfr',
              '-pix_fmt',
              'yuv420p',
              '-c:v',
              'libx264',
              '-movflags',
              '+faststart',
              outputPath,
            ],
            { timeout: 5 * 60_000 },
          );
          const first = this.frames[0].timestamp;
          const last = this.frames.at(-1)?.timestamp ?? first;
          return {
            path: outputPath,
            frames: this.frames.length,
            seconds: Math.round(last - first + LAST_FRAME_SECONDS),
          };
        } finally {
          await rm(this.dir, { recursive: true, force: true }).catch(() => {});
        }
      })(),
      (e) => (e instanceof Error ? e : new Error(String(e))),
    );
  }

  /** Drop the recording without encoding. */
  async discard(): Promise<void> {
    await Promise.all(this.writes);
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
