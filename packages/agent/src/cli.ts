/**
 * The orchestrator's commands, with every edge injected (environment, output,
 * terminal, how long `start` runs) so they can be tested from outside.
 *
 *   funny-orchestrator start [--config <file>]   run the issue factory
 *   funny-orchestrator status                    list its runs
 *
 * The factory home (`FUNNY_FACTORY_HOME`, default `~/.funny/factory`) holds
 * the default settings file (`config.yaml`) and the state store (`state.db`).
 */

import { homedir } from 'os';
import { join } from 'path';

import { openRunStore } from './adapters/sqlite-run-store.js';
import { childProcessStepLauncher } from './adapters/worktree-workspace.js';
import { composeFactory } from './compose.js';
import { createFactoryLog } from './infrastructure/factory-log.js';
import { systemClock } from './ports/clock.js';
import type { FactoryRun, RunStore } from './ports/run-store.js';
import { loadFactorySettings } from './settings/load.js';
import {
  forgetSecretEnv,
  redactor,
  resolveFactorySecrets,
  secretEnvValues,
  secretValues,
  type SecretSources,
} from './settings/secrets.js';

/** How often `start` looks for ready issues. */
const TICK_MS = 60_000;

const USAGE = 'Usage: funny-orchestrator <start [--config <file>] | status>';

export interface OrchestratorIo extends SecretSources {
  /** The process environment; `start` removes the secrets from it once read. */
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The current time, for the day `status` counts runs started on. Default: now. */
  now?: () => Date;
  /** Resolves when `start` should stop (a signal, in the real process). */
  untilStopped: () => Promise<void>;
}

const factoryHome = (env: OrchestratorIo['env']) =>
  env.FUNNY_FACTORY_HOME || join(homedir(), '.funny', 'factory');

const stateDbPath = (env: OrchestratorIo['env']) => join(factoryHome(env), 'state.db');

const today = (io: OrchestratorIo) => (io.now?.() ?? new Date()).toISOString().slice(0, 10);

function usage(io: OrchestratorIo): number {
  io.stderr(`${USAGE}\n`);
  return 2;
}

/** Opens the state store; a store that cannot open is a refusal, not a crash. */
function openStore(io: OrchestratorIo, refuse: (message: string) => void): RunStore | null {
  try {
    return openRunStore(stateDbPath(io.env));
  } catch (error) {
    refuse(
      `Cannot open the state store ${stateDbPath(io.env)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function configPathFrom(args: string[], home: string): string | null {
  if (args.length === 0) return join(home, 'config.yaml');
  if (args[0] === '--config' && args[1] && args.length === 2) return args[1];
  return null;
}

async function start(args: string[], io: OrchestratorIo): Promise<number> {
  const configPath = configPathFrom(args, factoryHome(io.env));
  if (!configPath) return usage(io);
  // Every message goes through the redactor, refusals included.
  const envSecrets = secretEnvValues(io.env);
  const refuse = (message: string) => io.stderr(`${redactor(envSecrets)(message)}\n`);
  const settings = loadFactorySettings(configPath);
  if (settings.isErr()) {
    refuse(settings.error);
    return 1;
  }
  const secrets = await resolveFactorySecrets(settings.value, io);
  forgetSecretEnv(io.env);
  if (secrets.isErr()) {
    refuse(secrets.error);
    return 1;
  }

  const redact = redactor([...envSecrets, ...secretValues(secrets.value)]);
  const log = createFactoryLog({ out: io.stdout, err: io.stderr }, redact);
  const store = openStore(io, (message) => log.error(message));
  if (!store) return 1;
  try {
    const { github, limits, model } = settings.value;
    log.info('Issue factory started', {
      login: github.login,
      model,
      concurrency: limits.concurrency,
      daily: limits.daily,
      autoMerge: settings.value.auto_merge,
    });
    for (const project of settings.value.projects) {
      log.info(`  ${project.repo} (${project.workspace})`, { path: project.path });
      if (project.workspace === 'sandbox') {
        log.warn(`  ${project.repo}: sandbox workspaces are not supported yet; it is skipped`);
      }
    }
    const factory = composeFactory(
      { settings: settings.value, secrets: secrets.value, store, log, home: factoryHome(io.env) },
      { clock: systemClock, launchStep: childProcessStepLauncher, env: io.env },
    );
    let stopping = false;
    const stopped = io.untilStopped().then(() => {
      stopping = true;
    });
    // A stop requested at startup wins over the first tick.
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 0))]);
    while (!stopping) {
      await factory.tick();
      await Promise.race([stopped, systemClock.sleep(TICK_MS)]);
    }
    // No new admissions; factory runs in flight finish before the store closes.
    log.info('Issue factory stopping: waiting for the factory runs in flight');
    await factory.idle();
    log.info('Issue factory stopped');
    return 0;
  } finally {
    store.close();
  }
}

function formatRun(run: FactoryRun): string {
  return [
    `${run.repo}#${run.issueNumber}`.padEnd(28),
    run.state.padEnd(12),
    run.prUrl ?? '-',
    run.reason ? `(${run.reason})` : '',
  ]
    .join('  ')
    .trimEnd();
}

function status(args: string[], io: OrchestratorIo): number {
  if (args.length > 0) return usage(io);
  const store = openStore(io, (message) => io.stderr(`${message}\n`));
  if (!store) return 1;
  try {
    const runs = store.list();
    io.stdout(runs.length === 0 ? 'No factory runs yet.\n' : `${runs.map(formatRun).join('\n')}\n`);
    io.stdout(`Started today: ${store.startedOn(today(io))}\n`);
    return 0;
  } finally {
    store.close();
  }
}

/** Runs one command; resolves to the process exit code. */
export async function runOrchestratorCli(argv: string[], io: OrchestratorIo): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'start') return start(args, io);
  if (command === 'status') return status(args, io);
  const help = command === '--help' || command === '-h';
  (help ? io.stdout : io.stderr)(`${USAGE}\n`);
  return help ? 0 : 2;
}
