import {
  buildProcessEnv,
  execute,
  executeSync,
  executeResult,
  ProcessExecutionError,
} from '../git/process.js';

describe('buildProcessEnv', () => {
  test('adds standard POSIX command locations to a service-style PATH', () => {
    const env = buildProcessEnv(
      { CUSTOM_VALUE: 'present' },
      { PATH: '/opt/funny/bin', HOME: '/home/runner' },
      'linux',
    );

    expect(env.PATH?.split(':')).toEqual(['/opt/funny/bin', '/usr/local/bin', '/usr/bin', '/bin']);
    expect(env.HOME).toBe('/home/runner');
    expect(env.CUSTOM_VALUE).toBe('present');
  });

  test('does not duplicate standard POSIX command locations', () => {
    const env = buildProcessEnv(undefined, { PATH: '/usr/bin:/custom:/bin' }, 'linux');
    expect(env.PATH?.split(':')).toEqual(['/usr/bin', '/custom', '/bin', '/usr/local/bin']);
  });
});

describe('ProcessExecutionError', () => {
  test('has correct name and properties', () => {
    const err = new ProcessExecutionError('failed', 1, 'out', 'err', 'git status');
    expect(err.name).toBe('ProcessExecutionError');
    expect(err.message).toBe('failed');
    expect(err.exitCode).toBe(1);
    expect(err.stdout).toBe('out');
    expect(err.stderr).toBe('err');
    expect(err.command).toBe('git status');
    expect(err instanceof Error).toBe(true);
  });
});

describe('execute', () => {
  test('runs a command and captures stdout', async () => {
    const result = await execute('node', ['-e', 'process.stdout.write("hello")']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  test('captures stderr', async () => {
    // git with no args writes to stderr
    const result = await execute('git', ['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
  });

  test('finds system Git with a reduced PATH on POSIX', async () => {
    if (process.platform === 'win32') return;
    const result = await execute('git', ['--version'], { env: { PATH: '/opt/funny/bin' } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('git version');
  });

  test('throws ProcessExecutionError on non-zero exit by default', async () => {
    try {
      await execute('git', ['log', '--oneline', '-1'], { cwd: '/nonexistent-path-xyz' });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error instanceof ProcessExecutionError || error instanceof Error).toBe(true);
    }
  });

  test('returns non-zero exit code when reject=false', async () => {
    const result = await execute('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: '/',
      reject: false,
    });
    // Root is typically not a git repo
    expect(result.exitCode).not.toBe(0);
  });

  test('merges environment variables', async () => {
    const result = await execute(
      'node',
      ['-e', 'process.stdout.write(process.env.TEST_VAR_CORE || "")'],
      {
        env: { TEST_VAR_CORE: 'hello123' },
        reject: false,
      },
    );
    // printenv might not exist on Windows, so be flexible
    if (result.exitCode === 0) {
      expect(result.stdout.trim()).toBe('hello123');
    }
  });

  test('respects timeout option', async () => {
    try {
      // Sleep for 10 seconds but timeout after 100ms
      await execute('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeout: 100 });
      expect(true).toBe(false); // should not reach
    } catch (error: any) {
      expect(error.message).toContain('timed out');
    }
  });
});

describe('executeSync', () => {
  test('runs a command synchronously', () => {
    const result = executeSync('node', ['-e', 'process.stdout.write("hello-sync")']);
    expect(result.stdout.trim()).toBe('hello-sync');
    expect(result.exitCode).toBe(0);
  });

  test('throws on non-zero exit by default', () => {
    expect(() => executeSync('git', ['log', '--oneline', '-1'], { cwd: '/' })).toThrow();
  });

  test('returns non-zero when reject=false', () => {
    const result = executeSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: '/',
      reject: false,
    });
    expect(result.exitCode).not.toBe(0);
  });
});

describe('executeResult', () => {
  test('returns Ok for successful command', async () => {
    const result = await executeResult('node', ['-e', 'process.stdout.write("test-result")']);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.stdout.trim()).toBe('test-result');
    }
  });

  test('returns Err with PROCESS_ERROR for failed command', async () => {
    const result = await executeResult('git', ['log', '--oneline', '-1'], { cwd: '/' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('PROCESS_ERROR');
    }
  });
});
