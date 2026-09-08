import { existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

/** Locate the SDK's CLI wrapper for login and MCP as well as agent execution. */
export function bundledCodexBinary(): string | null {
  try {
    const sdkRequire = createRequire(import.meta.resolve('@openai/codex-sdk'));
    const packagePath = sdkRequire.resolve('@openai/codex/package.json');
    const binary = join(dirname(packagePath), 'bin', 'codex.js');
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}
