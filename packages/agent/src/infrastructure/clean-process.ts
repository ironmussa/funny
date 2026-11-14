/**
 * Runs a process with exactly the environment it is given: nothing is
 * inherited from the orchestrator (no `GH_TOKEN`, no `HOME`, no secrets).
 */

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runClean(
  command: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<ProcessResult> {
  try {
    const child = Bun.spawn(command, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
