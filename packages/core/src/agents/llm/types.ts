import type { z } from 'zod';

/** A plain tool definition (no Vercel AI SDK dependency) */
export interface ToolDef {
  description: string;
  parameters: z.ZodType<any>;
  execute: (args: any) => Promise<string>;
}
