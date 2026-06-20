import { HarnessError } from '../errors.js';
import type {
  HarnessAgentRequest,
  HarnessAgentResult,
  HarnessApprovalDecision,
  HarnessApprovalRequest,
  HarnessCommandRequest,
  HarnessCommandResult,
  HarnessRuntime,
} from '../runtime.js';
import type { SandboxExecutionHandle, SandboxExecutionRequest } from '../sandbox.js';

export interface ActionResultLike {
  ok: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ActionProviderLike {
  spawnAgent(opts: {
    prompt: string;
    cwd: string;
    mode?: 'plan' | 'autoEdit' | 'confirmEdit';
    model?: string;
    provider?: string;
    context?: string;
    agent?: unknown;
    allowedTools?: string[];
    disallowedTools?: string[];
  }): Promise<ActionResultLike>;
  runCommand?(opts: { command: string; cwd: string; timeout?: number }): Promise<ActionResultLike>;
  notify?(opts: {
    message: string;
    level?: 'info' | 'warning' | 'error';
  }): Promise<ActionResultLike>;
  requestApproval?(opts: {
    gateId: string;
    message: string;
    captureResponse?: boolean;
    timeoutMs?: number;
  }): Promise<HarnessApprovalDecision>;
}

export interface ActionProviderRuntimeOptions {
  provider: ActionProviderLike;
  name?: string;
  resolveSandbox?: (request: SandboxExecutionRequest) => Promise<SandboxExecutionHandle>;
  supportsToolExposure?: boolean;
  supportsProcessSandbox?: boolean;
  supportsRunnerSandbox?: boolean;
}

export function createActionProviderRuntime(options: ActionProviderRuntimeOptions): HarnessRuntime {
  const actionProvider = options.provider;
  return {
    name: options.name ?? 'action-provider',
    capabilities: {
      commands: !!actionProvider.runCommand,
      approvals: !!actionProvider.requestApproval,
      notifications: !!actionProvider.notify,
      toolExposure: !!options.supportsToolExposure,
      processSandbox: !!options.supportsProcessSandbox,
      runnerSandbox: !!options.supportsRunnerSandbox,
    },

    async spawnAgent(request) {
      if (request.tools.length > 0 && !options.supportsToolExposure) {
        throw new HarnessError(
          'unsupported_tool_exposure',
          'ActionProvider runtime cannot expose custom tools to agents',
        );
      }
      return mapActionResult(
        await actionProvider.spawnAgent({
          prompt: request.prompt,
          cwd: request.cwd,
          mode: toRuntimeMode(request.agent.permissionMode),
          model: request.agent.model,
          provider: request.agent.provider,
          context: request.agent.instructions,
          allowedTools: [...request.agent.allowedTools],
          disallowedTools: [...request.agent.disallowedTools],
        }),
      );
    },

    async runCommand(request) {
      if (!actionProvider.runCommand) {
        throw new HarnessError('unsupported_capability', 'ActionProvider has no runCommand action');
      }
      return mapCommandResult(
        await actionProvider.runCommand({
          command: request.command,
          cwd: request.cwd,
          timeout: request.timeoutMs,
        }),
      );
    },

    async requestApproval(request) {
      if (!actionProvider.requestApproval) {
        throw new HarnessError(
          'approval_unavailable',
          'ActionProvider has no requestApproval action',
        );
      }
      return actionProvider.requestApproval({
        gateId: request.gateId,
        message: request.message,
        captureResponse: request.captureResponse,
        timeoutMs: request.timeoutMs,
      });
    },

    async notify(event) {
      await actionProvider.notify?.({
        message: event.type,
        level: event.type.includes('failed') || event.type.includes('error') ? 'error' : 'info',
      });
    },

    async resolveSandbox(request) {
      if (!options.resolveSandbox) {
        throw new HarnessError(
          'unsupported_sandbox_backend',
          'ActionProvider runtime has no sandbox resolver',
        );
      }
      return options.resolveSandbox(request);
    },
  };
}

function mapActionResult(result: ActionResultLike): HarnessAgentResult {
  return {
    ok: result.ok,
    output: result.output,
    error: result.error,
    metadata: result.metadata,
    sessionId:
      typeof result.metadata?.sessionId === 'string' ? result.metadata.sessionId : undefined,
  };
}

function mapCommandResult(result: ActionResultLike): HarnessCommandResult {
  return {
    ok: result.ok,
    stdout: result.output,
    stderr: result.error,
    error: result.error,
  };
}

function toRuntimeMode(mode: string | undefined): 'plan' | 'autoEdit' | 'confirmEdit' | undefined {
  return mode === 'plan' || mode === 'autoEdit' || mode === 'confirmEdit' ? mode : undefined;
}

export type { HarnessAgentRequest, HarnessApprovalRequest, HarnessCommandRequest };
