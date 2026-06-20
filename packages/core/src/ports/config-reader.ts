import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import type { FunnyProjectConfig } from '@funny/shared';
import { funnyProjectConfigSchema } from '@funny/shared/funny-config-schema';
import { parseStoredJson } from '@funny/shared/json-validation';

const CONFIG_FILENAME = '.funny.json';

export function readProjectConfig(projectPath: string): FunnyProjectConfig | null {
  const configPath = resolve(projectPath, CONFIG_FILENAME);
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseStoredJson(funnyProjectConfigSchema, raw, configPath);
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
}
