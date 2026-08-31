import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DiagnosticService } from '@funny/client-core';

export interface NativeSessionMaterial {
  cookieHeader: string;
}

export interface NativeSessionStore {
  load(): NativeSessionMaterial | null;
  save(material: NativeSessionMaterial): void;
  clear(): void;
}

export class FileNativeSessionStore implements NativeSessionStore {
  constructor(
    private readonly filePath: string,
    private readonly diagnostics: DiagnosticService,
    private readonly persistent = true,
  ) {}

  load(): NativeSessionMaterial | null {
    if (!this.persistent) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as { cookieHeader?: unknown }).cookieHeader !== 'string'
      ) {
        throw new Error('Invalid persisted native session');
      }
      return { cookieHeader: (parsed as { cookieHeader: string }).cookieHeader };
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.diagnostics.report({ capability: 'storage', operation: 'session.load', error });
      }
      return null;
    }
  }

  save(material: NativeSessionMaterial): void {
    if (!this.persistent) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${this.filePath}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(material)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      this.diagnostics.report({ capability: 'storage', operation: 'session.save', error });
    }
  }

  clear(): void {
    if (!this.persistent) return;
    try {
      unlinkSync(this.filePath);
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') {
        this.diagnostics.report({ capability: 'storage', operation: 'session.clear', error });
      }
    }
  }
}

export class MemoryNativeSessionStore implements NativeSessionStore {
  private material: NativeSessionMaterial | null = null;

  load(): NativeSessionMaterial | null {
    return this.material;
  }

  save(material: NativeSessionMaterial): void {
    this.material = material;
  }

  clear(): void {
    this.material = null;
  }
}
