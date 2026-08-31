import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type {
  DiagnosticService,
  StorageChange,
  StorageService,
  Unsubscribe,
} from '@funny/client-core';

function parseStoredValues(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Native storage root must be an object');
  }
  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new Error('Native storage values must be strings');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export class NativeKeyValueStorage implements StorageService {
  private readonly values = new Map<string, string>();
  private readonly listeners = new Set<(change: StorageChange) => void>();

  constructor(
    private readonly filePath: string,
    private readonly diagnostics: DiagnosticService,
  ) {
    try {
      const parsed = parseStoredValues(readFileSync(filePath, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) this.values.set(key, value);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        diagnostics.report({ capability: 'storage', operation: 'load', error });
      }
    }
  }

  read(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.values.set(key, value);
    this.persist('write');
    this.notify({ key, value });
  }

  remove(key: string): void {
    if (!this.values.delete(key)) return;
    this.persist('remove');
    this.notify({ key, value: null });
  }

  subscribe(listener: (change: StorageChange) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: StorageChange): void {
    for (const listener of this.listeners) listener(change);
  }

  private persist(operation: string): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(
        temporaryPath,
        `${JSON.stringify(Object.fromEntries(this.values), null, 2)}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      );
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      this.diagnostics.report({ capability: 'storage', operation, error });
    }
  }
}
