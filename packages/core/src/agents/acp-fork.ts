/**
 * @domain subdomain: Agent Process
 * @domain subdomain-type: core
 * @domain type: helper
 * @domain layer: domain
 *
 * Out-of-process ACP session fork: spawns the agent CLI just long enough to
 * call `unstable_forkSession()` against the source session, returns the new
 * sessionId, and tears the process down. Used by the runtime fork service
 * so that codex / gemini / pi / cursor conversations can be branched the
 * same way Claude SDK conversations are.
 */

import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';

type AcpProvider = 'codex' | 'gemini' | 'pi' | 'cursor' | 'opencode';

/** Resolve the CLI command + args to run an ACP-compliant agent over stdio. */
function resolveAcpCommand(provider: AcpProvider): { command: string; args: string[] } {
  switch (provider) {
    case 'codex': {
      const explicit =
        process.env.CODEX_ACP_BINARY_PATH || process.env.ACP_CODEX_BIN || process.env.CODEX_BIN;
      if (explicit) return { command: explicit, args: [] };
      if (process.env.CODEX_ACP_USE_NPX === '1') {
        return { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] };
      }
      return { command: 'codex-acp', args: [] };
    }
    case 'gemini': {
      const bin = process.env.GEMINI_BINARY_PATH || process.env.ACP_GEMINI_BIN || 'gemini';
      return { command: bin, args: ['--acp'] };
    }
    case 'pi': {
      const explicit = process.env.PI_ACP_BINARY_PATH || process.env.ACP_PI_BIN;
      if (explicit) return { command: explicit, args: [] };
      if (process.env.PI_ACP_USE_NPX === '1') {
        return { command: 'npx', args: ['-y', 'pi-acp'] };
      }
      return { command: 'pi-acp', args: [] };
    }
    case 'cursor': {
      const explicit = process.env.CURSOR_BINARY_PATH || process.env.ACP_CURSOR_BIN;
      if (explicit) return { command: explicit, args: ['acp'] };
      if (process.env.CURSOR_ACP_USE_NPX === '1') {
        return { command: 'npx', args: ['-y', 'cursor-agent', 'acp'] };
      }
      return { command: 'cursor-agent', args: ['acp'] };
    }
    case 'opencode': {
      const explicit = process.env.OPENCODE_BIN || process.env.ACP_OPENCODE_BIN;
      if (explicit) return { command: explicit, args: ['acp'] };
      if (process.env.OPENCODE_ACP_USE_NPX === '1') {
        return { command: 'npx', args: ['-y', 'opencode-ai', 'acp'] };
      }
      return { command: 'opencode', args: ['acp'] };
    }
  }
}

export interface ForkAcpSessionOptions {
  provider: AcpProvider;
  sessionId: string;
  cwd: string;
  env?: Record<string, string | undefined>;
}

export interface ForkAcpSessionResult {
  /** Native ACP fork succeeded — the new session is owned by the agent's session store. */
  ok: true;
  newSessionId: string;
}

export interface ForkAcpSessionUnsupported {
  /** Agent did not advertise the `session.fork` capability. Caller should fall back. */
  ok: false;
  reason: 'capability_not_advertised' | 'agent_error' | 'spawn_failed';
  message?: string;
}

/**
 * Fork an ACP session out of process. Resolves with the new sessionId on
 * success; resolves with `{ ok: false }` if the agent doesn't advertise the
 * capability or the call fails — callers can then decide whether to fall back
 * to a non-native "copy DB messages" branch.
 */
export async function forkAcpSession(
  opts: ForkAcpSessionOptions,
): Promise<ForkAcpSessionResult | ForkAcpSessionUnsupported> {
  let SDK: typeof import('@agentclientprotocol/sdk');
  try {
    SDK = await import('@agentclientprotocol/sdk');
  } catch {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: 'ACP SDK (@agentclientprotocol/sdk) is not installed',
    };
  }

  const { ClientSideConnection, ndJsonStream } = SDK;
  const { command, args } = resolveAcpCommand(opts.provider);

  const child = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
    shell: process.platform === 'win32',
  });

  // Drain stderr so the child doesn't block on a full pipe buffer.
  child.stderr?.on('data', () => {});

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: (err as Error)?.message,
    };
  }

  const outputStream = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(outputStream, inputStream);

  // Minimal client — fork shouldn't trigger sessionUpdate / requestPermission,
  // but the SDK requires both methods to be present.
  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: async () => {},
      requestPermission: async (params) => ({
        outcome: { outcome: 'selected', optionId: params.options[0]?.optionId ?? '' },
      }),
    }),
    stream,
  );

  const cleanup = () => {
    if (!child.killed) child.kill('SIGTERM');
  };

  try {
    const initResult = await connection.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'funny-fork', version: '1.0.0' },
      clientCapabilities: {},
    });

    // The fork capability lives under `agentCapabilities.sessions.fork` for
    // codex/gemini/pi/cursor, but opencode advertises it under
    // `agentCapabilities.sessionCapabilities.fork` — accept either shape.
    const caps = initResult.agentCapabilities as Record<string, unknown> | undefined;
    const sessions = caps?.sessions as { fork?: unknown } | undefined;
    const sessionCapabilities = caps?.sessionCapabilities as { fork?: unknown } | undefined;
    if (!sessions?.fork && !sessionCapabilities?.fork) {
      cleanup();
      return { ok: false, reason: 'capability_not_advertised' };
    }

    const result = await connection.unstable_forkSession({
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: [],
    });

    cleanup();
    return { ok: true, newSessionId: result.sessionId };
  } catch (err) {
    cleanup();
    return {
      ok: false,
      reason: 'agent_error',
      message: (err as Error)?.message,
    };
  }
}
