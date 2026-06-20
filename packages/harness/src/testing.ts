import type { HarnessEvent } from './events.js';
import type {
  HarnessAgentRequest,
  HarnessAgentResult,
  HarnessApprovalDecision,
  HarnessApprovalRequest,
  HarnessCommandRequest,
  HarnessCommandResult,
  HarnessRuntime,
  HarnessRuntimeCapabilities,
} from './runtime.js';
import type { SandboxExecutionHandle, SandboxExecutionRequest } from './sandbox.js';

export interface FakeRuntimeOptions {
  capabilities?: HarnessRuntimeCapabilities;
  spawnAgent?: (request: HarnessAgentRequest) => Promise<HarnessAgentResult> | HarnessAgentResult;
  runCommand?: (
    request: HarnessCommandRequest,
  ) => Promise<HarnessCommandResult> | HarnessCommandResult;
  requestApproval?: (
    request: HarnessApprovalRequest,
  ) => Promise<HarnessApprovalDecision> | HarnessApprovalDecision;
  resolveSandbox?: (
    request: SandboxExecutionRequest,
  ) => Promise<SandboxExecutionHandle> | SandboxExecutionHandle;
}

export interface FakeRuntime extends HarnessRuntime {
  requests: HarnessAgentRequest[];
  events: HarnessEvent[];
  sandboxRequests: SandboxExecutionRequest[];
}

export function createFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const requests: HarnessAgentRequest[] = [];
  const events: HarnessEvent[] = [];
  const sandboxRequests: SandboxExecutionRequest[] = [];

  return {
    name: 'fake',
    capabilities: options.capabilities ?? {
      commands: !!options.runCommand,
      approvals: !!options.requestApproval,
      notifications: true,
      toolExposure: true,
      processSandbox: !!options.resolveSandbox,
      runnerSandbox: !!options.resolveSandbox,
      cancellation: true,
    },
    requests,
    events,
    sandboxRequests,
    async spawnAgent(request) {
      requests.push(request);
      if (options.spawnAgent) return options.spawnAgent(request);
      return {
        ok: true,
        output: `fake:${request.prompt}`,
        sessionId: request.sessionId ?? 'fake-session',
      };
    },
    async runCommand(request) {
      if (options.runCommand) return options.runCommand(request);
      return { ok: true, stdout: '', exitCode: 0 };
    },
    async requestApproval(request) {
      if (options.requestApproval) return options.requestApproval(request);
      return { decision: 'approve' };
    },
    async resolveSandbox(request) {
      sandboxRequests.push(request);
      if (options.resolveSandbox) return options.resolveSandbox(request);
      return { kind: request.intent.kind, id: 'fake-sandbox', cwd: request.cwd };
    },
    notify(event) {
      events.push(event);
    },
  };
}
