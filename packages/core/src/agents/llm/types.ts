import type { z, ZodTypeAny } from 'zod';

/** A plain tool definition (no Vercel AI SDK dependency) */
export interface ToolDef<TParameters extends ZodTypeAny = ZodTypeAny> {
  description: string;
  parameters: TParameters;
  execute: (args: z.infer<TParameters>) => Promise<string>;
}

export function defineTool<TParameters extends ZodTypeAny>(
  definition: ToolDef<TParameters>,
): ToolDef<TParameters> {
  return definition;
}
