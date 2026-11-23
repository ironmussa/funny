import { execute } from '@funny/core/git';

/**
 * `cargo --version`, or null when the Rust toolchain is not installed or does
 * not answer within 5 s. Asynchronous on purpose: a sync spawn here held the
 * runner's event loop (agent streams, PTYs, gRPC) for as long as cargo took.
 */
export async function readCargoVersion(): Promise<string | null> {
  try {
    const result = await execute('cargo', ['--version'], { timeout: 5000, reject: false });
    const version = result.stdout.trim();
    return result.exitCode === 0 && version ? version : null;
  } catch {
    return null;
  }
}
