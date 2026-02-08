/**
 * Skills Service — manages Claude Code skills.
 * Reads installed skills from ~/.agents/.skill-lock.json
 * and SKILL.md frontmatter. Installs via `npx skills add`.
 */

import { readFileSync, existsSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execute } from '../utils/process.js';
import type { Skill } from '@a-parallel/shared';

const AGENTS_DIR = join(homedir(), '.agents');
const SKILLS_DIR = join(AGENTS_DIR, 'skills');
const LOCK_FILE = join(AGENTS_DIR, '.skill-lock.json');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');

interface LockFileSkill {
  source: string;
  sourceType: string;
  sourceUrl: string;
  skillPath?: string;
  skillFolderHash?: string;
  installedAt: string;
  updatedAt: string;
}

interface LockFile {
  version: number;
  skills: Record<string, LockFileSkill>;
}

/**
 * Parse YAML frontmatter from SKILL.md to extract description.
 */
function parseSkillDescription(skillName: string): string {
  const skillMdPath = join(SKILLS_DIR, skillName, 'SKILL.md');
  if (!existsSync(skillMdPath)) return '';

  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return '';

    const fm = fmMatch[1];
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    return descMatch ? descMatch[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * List all installed skills by reading the lock file.
 */
export function listSkills(): Skill[] {
  if (!existsSync(LOCK_FILE)) return [];

  try {
    const raw = readFileSync(LOCK_FILE, 'utf-8');
    const lockFile: LockFile = JSON.parse(raw);
    const skills: Skill[] = [];

    for (const [name, entry] of Object.entries(lockFile.skills)) {
      skills.push({
        name,
        description: parseSkillDescription(name),
        source: entry.source,
        sourceUrl: entry.sourceUrl,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
      });
    }

    return skills;
  } catch (err) {
    console.error('[skills-service] Failed to read lock file:', err);
    return [];
  }
}

/**
 * Install a skill via `npx skills add`.
 * Identifier format: owner/repo@skill-name
 */
export async function addSkill(identifier: string): Promise<void> {
  console.log(`[skills-service] Installing skill: ${identifier}`);

  await execute('npx', ['skills', 'add', identifier, '-g', '-y'], {
    cwd: homedir(),
    timeout: 60_000,
  });
}

/**
 * Remove a skill by deleting its directory and symlink,
 * and updating the lock file.
 */
export function removeSkill(name: string): void {
  console.log(`[skills-service] Removing skill: ${name}`);

  // Remove skill directory
  const skillDir = join(SKILLS_DIR, name);
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }

  // Remove symlink in ~/.claude/skills/
  const symlinkPath = join(CLAUDE_SKILLS_DIR, name);
  if (existsSync(symlinkPath)) {
    try {
      unlinkSync(symlinkPath);
    } catch {
      rmSync(symlinkPath, { recursive: true, force: true });
    }
  }

  // Update lock file
  if (existsSync(LOCK_FILE)) {
    try {
      const raw = readFileSync(LOCK_FILE, 'utf-8');
      const lockFile: LockFile = JSON.parse(raw);
      delete lockFile.skills[name];
      const { writeFileSync } = require('fs');
      writeFileSync(LOCK_FILE, JSON.stringify(lockFile, null, 2));
    } catch (err) {
      console.error('[skills-service] Failed to update lock file:', err);
    }
  }
}

/**
 * Recommended skills list.
 */
export const RECOMMENDED_SKILLS = [
  {
    name: 'find-skills',
    description: 'Discover and install agent skills from the open ecosystem',
    identifier: 'vercel-labs/skills@find-skills',
  },
  {
    name: 'nextjs-best-practices',
    description: 'Next.js App Router patterns, server components, and best practices',
    identifier: 'vercel-labs/agent-skills@nextjs-best-practices',
  },
  {
    name: 'vercel-react-best-practices',
    description: 'React best practices and patterns from Vercel',
    identifier: 'vercel-labs/agent-skills@vercel-react-best-practices',
  },
  {
    name: 'remotion-best-practices',
    description: 'Video creation in React with Remotion',
    identifier: 'remotion-dev/skills@remotion-best-practices',
  },
  {
    name: 'supabase',
    description: 'Supabase database, auth, and real-time patterns',
    identifier: 'anthropics/skills@supabase',
  },
  {
    name: 'firebase',
    description: 'Firebase integration and architecture patterns',
    identifier: 'anthropics/skills@firebase',
  },
  {
    name: 'tailwindcss',
    description: 'Tailwind CSS utility-first styling patterns',
    identifier: 'anthropics/skills@tailwindcss',
  },
  {
    name: 'playwright-testing',
    description: 'End-to-end testing with Playwright',
    identifier: 'anthropics/skills@playwright-testing',
  },
];
