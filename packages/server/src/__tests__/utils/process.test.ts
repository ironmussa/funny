import { describe, test, expect } from 'bun:test';

import { ProcessExecutionError, execute, executeSync, executeWithLogging } from '@funny/core/git';

describe('ProcessExecutionError', () => {
  test('sets all properties correctly', () => {
    const err = new ProcessExecutionError(
      'Command failed: test',
      1,
      'stdout output',
      'stderr output',
      'test --flag',
    );

    expect(err.message).toBe('Command failed: test');
    expect(err.exitCode).toBe(1);
    expect(err.stdout).toBe('stdout output');
    expect(err.stderr).toBe('stderr output');
    expect(err.command).toBe('test --flag');
    expect(err.name).toBe('ProcessExecutionError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProcessExecutionError);
  });
});

describe('execute (async)', () => {
  test('runs a successful command', async () => {
    const result = await execute('echo', ['hello world']);
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.exitCode).toBe(0);
  });

  test('returns stderr from successful command', async () => {
    const result = await execute('node', ['-e', 'process.stderr.write("warn")']);
    expect(result.stderr).toContain('warn');
    expect(result.exitCode).toBe(0);
  });

  test('throws ProcessExecutionError on non-zero exit', async () => {
    try {
      await execute('node', ['-e', 'process.exit(1)']);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecutionError);
      expect((err as ProcessExecutionError).exitCode).toBe(1);
    }
  });

  test('does not throw when reject is false', async () => {
    const result = await execute('node', ['-e', 'process.exit(42)'], {
      reject: false,
    });
    expect(result.exitCode).toBe(42);
  });

  test('respects cwd option', async () => {
    const result = await execute('node', ['-e', 'console.log(process.cwd())'], {
      cwd: process.cwd(),
    });
    expect(result.stdout.trim()).toBeTruthy();
  });
});

describe('executeSync', () => {
  test('runs a successful command', () => {
    const result = executeSync('echo', ['sync test']);
    expect(result.stdout.trim()).toBe('sync test');
    expect(result.exitCode).toBe(0);
  });

  test('throws ProcessExecutionError on non-zero exit', () => {
    try {
      executeSync('node', ['-e', 'process.exit(1)']);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecutionError);
    }
  });

  test('does not throw when reject is false', () => {
    const result = executeSync('node', ['-e', 'process.exit(5)'], {
      reject: false,
    });
    expect(result.exitCode).toBe(5);
  });
});

describe('executeWithLogging', () => {
  test('returns the same result as execute', async () => {
    const result = await executeWithLogging('echo', ['logging test']);
    expect(result.stdout.trim()).toBe('logging test');
    expect(result.exitCode).toBe(0);
  });

  test('throws on failed command', async () => {
    try {
      await executeWithLogging('node', ['-e', 'process.exit(1)']);
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessExecutionError);
    }
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('execute edge cases', () => {
  test('timeout kills process that runs too long', async () => {
    try {
      await execute('node', ['-e', 'setTimeout(()=>{},60000)'], {
        timeout: 500,
      });
      expect.unreachable('Should have timed out');
    } catch (err: any) {
      expect(err.message).toContain('timed out');
    }
  });

  test('handles large stdout output', async () => {
    const result = await execute('node', [
      '-e',
      'for(let i=0;i<10000;i++) process.stdout.write("line " + i + "\\n")',
    ]);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(10000);
  });

  test('handles arguments with special characters', async () => {
    const result = await execute('node', ['-e', 'console.log("hello \\"world\\" & <tag>")']);
    expect(result.stdout).toContain('hello');
    expect(result.stdout).toContain('world');
  });

  test('handles arguments with spaces', async () => {
    const result = await execute('node', ['-e', 'console.log("hello world with spaces")']);
    expect(result.stdout.trim()).toBe('hello world with spaces');
  });

  test('captures both stdout and stderr simultaneously', async () => {
    const result = await execute('node', [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err")',
    ]);
    expect(result.stdout).toContain('out');
    expect(result.stderr).toContain('err');
  });

  test('handles empty stdout', async () => {
    const result = await execute('node', ['-e', '']);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('preserves high exit codes', async () => {
    const result = await execute('node', ['-e', 'process.exit(127)'], {
      reject: false,
    });
    expect(result.exitCode).toBe(127);
  });
});

describe('executeSync edge cases', () => {
  test('handles empty output', () => {
    const result = executeSync('node', ['-e', '']);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('handles unicode in output', () => {
    const result = executeSync('node', ['-e', 'console.log("🚀 日本語")']);
    expect(result.stdout.trim()).toBe('🚀 日本語');
  });
});
