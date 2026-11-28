import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

const DEFAULT_PROMPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'defaults',
  'prompts',
  'factory-flow-setup.md',
);

export interface RenderFactoryFlowSetupPromptInput {
  flowName: string;
  flowPath: string;
  defaultBranch: string;
  facts: unknown;
  startingFile: string;
  promptFilePath?: string;
}

/**
 * Load and render the built-in `factory-flow-setup.md` prompt with the
 * repository's detected stack facts and starting flow YAML.
 */
export async function renderFactoryFlowSetupPrompt(
  input: RenderFactoryFlowSetupPromptInput,
): Promise<string> {
  const template = await readFile(input.promptFilePath ?? DEFAULT_PROMPT_PATH, 'utf8');
  const replacements = {
    '{{flow_name}}': input.flowName,
    '{{flow_path}}': input.flowPath,
    '{{default_branch}}': input.defaultBranch,
    '{{facts_json}}': JSON.stringify(input.facts, null, 2),
    '{{starting_file}}': input.startingFile.trimEnd(),
  };
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.split(token).join(value);
  }
  return rendered;
}

const setupAgentCanarySchema = z.object({
  ruleIndex: z.number().int().min(0),
  passingPath: z.string().min(1),
  failingPath: z.string().min(1),
});

const setupAgentUncoveredSchema = z.object({
  scope: z.string().min(1),
  reason: z.string().min(1),
});

export const setupAgentManifestSchema = z.object({
  canaries: z.array(setupAgentCanarySchema).min(1),
  uncovered: z.array(setupAgentUncoveredSchema).default([]),
});

export type SetupAgentManifest = z.infer<typeof setupAgentManifestSchema>;

/**
 * Extract the last valid JSON manifest block from the setup agent's final
 * assistant message. Returns null if none is found or it does not match the
 * manifest schema.
 */
export function parseSetupAgentManifest(text: string): SetupAgentManifest | null {
  const fenceRegex = /^```[^\n]*\n([\s\S]*?)^```/gm;
  const blocks: string[] = [];
  for (const match of text.matchAll(fenceRegex)) {
    if (match[1]) blocks.push(match[1].trim());
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const raw: unknown = JSON.parse(blocks[i]!);
      const parsed = setupAgentManifestSchema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      // Try earlier fenced blocks if the last one wasn't JSON.
    }
  }
  return null;
}
