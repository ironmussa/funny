# Node.js OS Communication & Process Execution Strategy

## Current State Analysis

### Issues Identified

1. **Command Injection Vulnerabilities**
   - String concatenation in git commands: `git add "${p}"` is vulnerable if `p` contains malicious input
   - User input directly in command strings without proper escaping

2. **Blocking Operations**
   - Using `execSync` blocks the Node.js event loop
   - Multiple synchronous git operations in loops (e.g., staging files)
   - Can cause server unresponsiveness under load

3. **Limited Error Information**
   - `execSync` provides minimal error context
   - Difficult to distinguish between different failure types

4. **Cross-Platform Issues**
   - Path handling differs between Windows and Unix
   - Command availability varies by platform
   - No handling for missing executables (git, gh)

## Recommended Solution: **execa**

### Why execa?

```bash
npm install execa
```

**Advantages:**

- ✅ Better error handling with detailed error objects
- ✅ Cross-platform by default (handles Windows path issues)
- ✅ Promise-based (async) with sync options when needed
- ✅ Strips ANSI escape codes automatically
- ✅ Better stdout/stderr handling
- ✅ Built-in command escaping
- ✅ Script execution support
- ✅ Timeout handling with cleaner cancellation
- ✅ Modern, actively maintained (5M+ weekly downloads)

### Implementation Example

```typescript
import { execa, execaSync } from 'execa';

// ❌ OLD (Vulnerable to injection)
export function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();
}

// ✅ NEW (Safe, async)
export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execa('git', args, {
    cwd,
    timeout: 30_000,
  });
  return stdout;
}

// ✅ NEW (Safe, sync when needed)
export function gitSync(args: string[], cwd: string): string {
  const { stdout } = execaSync('git', args, {
    cwd,
    timeout: 30_000,
  });
  return stdout;
}

// Usage examples:
// Before: git('add "file.txt"', cwd)
// After:  await git(['add', 'file.txt'], cwd)

// Before: git('commit -m "message"', cwd)
// After:  await git(['commit', '-m', 'message'], cwd)
```

## Alternative Libraries (Considered but Not Recommended)

### 1. **zx** (by Google)

```typescript
import { $ } from 'zx';
const output = await $`git status`;
```

- ✅ Very clean template literal syntax
- ✅ Great for scripting
- ❌ Too opinionated (auto-prints, colorizes)
- ❌ Harder to control in server environments
- ❌ Overkill for this use case

### 2. **shelljs**

```typescript
import shell from 'shelljs';
shell.exec('git status');
```

- ❌ Older, less active maintenance
- ❌ Synchronous by default
- ❌ Larger bundle size
- ❌ Not as modern as execa

### 3. **native child_process**

```typescript
import { spawn } from 'child_process';
```

- ✅ Built-in, no dependencies
- ❌ Verbose API
- ❌ Poor error handling
- ❌ Platform quirks require manual handling
- ❌ No automatic promise support

## Security Best Practices

### 1. Always Use Array Arguments (Not String Concatenation)

```typescript
// ❌ DANGEROUS - Command injection risk
await execa(`git commit -m "${userInput}"`);

// ✅ SAFE - Arguments are properly escaped
await execa('git', ['commit', '-m', userInput]);
```

### 2. Validate Paths Before Use

```typescript
import { resolve, isAbsolute } from 'path';
import { access } from 'fs/promises';

export async function validatePath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error('Path must be absolute');
  }

  try {
    await access(path);
    return resolve(path);
  } catch {
    throw new Error(`Path does not exist: ${path}`);
  }
}
```

### 3. Whitelist Commands

```typescript
const ALLOWED_COMMANDS = ['git', 'gh', 'node', 'npm'] as const;

export function isCommandAllowed(cmd: string): boolean {
  return ALLOWED_COMMANDS.includes(cmd as any);
}
```

## Implementation Strategy

### Phase 1: Create New Utility Layer (Non-Breaking)

```typescript
// src/utils/process.ts
import { execa, execaSync, type Options } from 'execa';

export interface ProcessOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  reject?: boolean; // false = don't throw on non-zero exit
}

export async function execute(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execa(command, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 30_000,
      env: options.env,
      reject: options.reject ?? true,
      all: true,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (error: any) {
    // Enhanced error with context
    if (error.exitCode !== undefined) {
      throw new ProcessExecutionError(
        `Command failed: ${command} ${args.join(' ')}`,
        error.exitCode,
        error.stdout,
        error.stderr,
        error.command,
      );
    }
    throw error;
  }
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    public exitCode: number,
    public stdout: string,
    public stderr: string,
    public command: string,
  ) {
    super(message);
    this.name = 'ProcessExecutionError';
  }
}
```

### Phase 2: Refactor Git Utils

```typescript
// src/utils/git-v2.ts (new file)
import { execute } from './process.js';
import { validatePath } from './path-validation.js';

export async function git(args: string[], cwd: string): Promise<string> {
  await validatePath(cwd);
  const { stdout } = await execute('git', args, { cwd });
  return stdout.trim();
}

export async function gitSafe(args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

export async function isGitRepo(path: string): Promise<boolean> {
  const result = await gitSafe(['rev-parse', '--is-inside-work-tree'], path);
  return result === 'true';
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export async function listBranches(cwd: string): Promise<string[]> {
  const output = await git(['branch', '--format=%(refname:short)'], cwd);
  return output
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
}

export async function stageFiles(cwd: string, paths: string[]): Promise<void> {
  // Execute in parallel for better performance
  await Promise.all(paths.map((path) => git(['add', path], cwd)));
}

export async function commit(cwd: string, message: string): Promise<string> {
  return git(['commit', '-m', message], cwd);
}
```

### Phase 3: Gradual Migration

1. Keep old `git.ts` for backward compatibility
2. Add new `git-v2.ts` with async implementations
3. Update routes one by one to use async versions
4. Add tests for both versions during transition
5. Remove old version once all routes migrated

## Performance Considerations

### 1. Parallel Execution

```typescript
// ❌ SLOW - Sequential (3 seconds if each takes 1s)
for (const path of paths) {
  await git(['add', path], cwd);
}

// ✅ FAST - Parallel (1 second total)
await Promise.all(paths.map((path) => git(['add', path], cwd)));
```

### 2. Batch Operations When Possible

```typescript
// ✅ BETTER - Single command for multiple files
await git(['add', ...paths], cwd);
```

### 3. Use Sync Only for Startup Operations

```typescript
// ✅ OK - Server startup (not in request handlers)
export function validateGitInstalled(): void {
  try {
    execaSync('git', ['--version']);
  } catch {
    throw new Error('Git is not installed');
  }
}

// ❌ BAD - Inside HTTP handler
app.get('/status', (c) => {
  const version = execaSync('git', ['--version']); // Blocks event loop!
  return c.json({ version });
});

// ✅ GOOD - Inside HTTP handler
app.get('/status', async (c) => {
  const { stdout: version } = await execa('git', ['--version']);
  return c.json({ version });
});
```

## Testing Strategy

```typescript
// tests/utils/process.test.ts
import { vi, describe, it, expect } from 'vitest';
import { execute } from '../src/utils/process';

// Mock execa for testing
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('process execution', () => {
  it('should execute command successfully', async () => {
    const { execa } = await import('execa');
    vi.mocked(execa).mockResolvedValue({
      stdout: 'success',
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await execute('git', ['status'], { cwd: '/test' });
    expect(result.stdout).toBe('success');
  });

  it('should handle command injection attempts', async () => {
    // This is safe because args are passed as array
    const maliciousInput = '; rm -rf /';
    await expect(execute('git', ['commit', '-m', maliciousInput], {})).rejects.toThrow();
  });
});
```

## Monitoring & Logging

```typescript
import { execute } from './process.js';

// Wrapper with logging
export async function executeWithLogging(command: string, args: string[], options: ProcessOptions) {
  const start = Date.now();
  console.log(`[exec] ${command} ${args.join(' ')}`);

  try {
    const result = await execute(command, args, options);
    const duration = Date.now() - start;
    console.log(`[exec] ✓ ${command} (${duration}ms)`);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[exec] ✗ ${command} (${duration}ms)`, error);
    throw error;
  }
}
```

## Recommended Next Steps

1. ✅ Install `execa`: `npm install execa --workspace=packages/server`
2. ✅ Create `src/utils/process.ts` with base utilities
3. ✅ Create `src/utils/git-v2.ts` with async git functions
4. ✅ Add security validation utilities
5. ✅ Update route handlers to async/await
6. ✅ Add comprehensive error handling
7. ✅ Write tests for all process execution
8. ✅ Remove old synchronous implementations

## Summary

**Use `execa`** - it's the industry standard for modern Node.js process execution:

- Most secure (proper argument escaping)
- Best error handling
- Cross-platform by default
- Async-first with sync fallback
- Great TypeScript support
- Actively maintained

Your application will be more secure, performant, and maintainable.
