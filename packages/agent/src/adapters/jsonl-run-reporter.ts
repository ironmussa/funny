/**
 * RunReporter that appends one JSON line per event to a run's event file.
 *
 * Appends are chained, so lines land in the order events were reported even
 * when callers do not wait for each one.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

import type { RunEvent, RunReporter } from '../ports/run-reporter.js';

export class JsonlRunReporter implements RunReporter {
  private tail: Promise<unknown>;

  constructor(private readonly filePath: string) {
    this.tail = mkdir(dirname(filePath), { recursive: true });
  }

  report(event: RunEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    const appended = this.tail.then(() => appendFile(this.filePath, line, 'utf-8'));
    // A failed append must not stop the next one.
    this.tail = appended.catch(() => undefined);
    return appended;
  }
}
