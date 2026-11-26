import type { ZodTypeAny } from 'zod';

import type {
  HarnessTool,
  HarnessToolDefinition,
  ToolExecutionContext,
  ToolInput,
  ToolResult,
} from './contracts.js';
import { HarnessError } from './errors.js';

export type {
  HarnessTool,
  HarnessToolDefinition,
  ToolExecutionContext,
  ToolInput,
  ToolResult,
} from './contracts.js';

function isFunction(value: unknown): value is (...args: never[]) => void {
  return typeof value === 'function';
}

export function defineTool<TSchema extends ZodTypeAny, TResult>(
  definition: HarnessToolDefinition<TSchema, TResult>,
): HarnessTool<TSchema, TResult> {
  if (!definition.name?.trim()) {
    throw new HarnessError('invalid_runtime_request', 'Tool name is required');
  }
  if (!definition.description?.trim()) {
    throw new HarnessError('invalid_runtime_request', 'Tool description is required');
  }
  if (!definition.inputSchema || !isFunction(definition.inputSchema.safeParse)) {
    throw new HarnessError('invalid_runtime_request', 'Tool inputSchema must be a Zod schema');
  }
  if (!isFunction(definition.handler)) {
    throw new HarnessError('invalid_runtime_request', 'Tool handler is required');
  }
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    handler: definition.handler,
    metadata: definition.metadata ? Object.freeze({ ...definition.metadata }) : undefined,
  });
}

export class ToolRegistry {
  private readonly tools = new Map<string, HarnessTool>();

  constructor(tools: readonly HarnessTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: HarnessTool): this {
    if (this.tools.has(tool.name)) {
      throw new HarnessError('duplicate_tool', `Tool "${tool.name}" is already registered`, {
        metadata: { toolName: tool.name },
      });
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): HarnessTool | undefined {
    return this.tools.get(name);
  }

  list(): readonly HarnessTool[] {
    return [...this.tools.values()];
  }

  async invoke(
    name: string,
    input: ToolInput,
    context: ToolExecutionContext = {},
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new HarnessError('invalid_runtime_request', `Tool "${name}" is not registered`, {
        metadata: { toolName: name },
      });
    }
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new HarnessError('tool_validation_failed', `Invalid input for tool "${name}"`, {
        metadata: { toolName: name, issues: parsed.error.issues },
      });
    }
    return tool.handler(parsed.data, context);
  }
}

export function createToolRegistry(tools: readonly HarnessTool[] = []): ToolRegistry {
  return new ToolRegistry(tools);
}
