/**
 * Skills Service — manages Claude Code skills.
 * Reads installed skills from ~/.agents/.skill-lock.json
 * and SKILL.md frontmatter. Installs via `npx skills add`.
 */

import { readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execute } from '@funny/core/git';
import type { Skill } from '@funny/shared';

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
 * Parse YAML frontmatter from a SKILL.md file to extract name and description.
 */
function parseSkillFrontmatter(skillMdPath: string): { name?: string; description?: string } {
  if (!existsSync(skillMdPath)) return {};

  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};

    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    return {
      name: nameMatch ? nameMatch[1].trim() : undefined,
      description: descMatch ? descMatch[1].trim() : undefined,
    };
  } catch {
    return {};
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
      const fm = parseSkillFrontmatter(join(SKILLS_DIR, name, 'SKILL.md'));
      skills.push({
        name,
        description: fm.description || '',
        source: entry.source,
        sourceUrl: entry.sourceUrl,
        installedAt: entry.installedAt,
        updatedAt: entry.updatedAt,
        scope: 'global',
      });
    }

    return skills;
  } catch (err) {
    console.error('[skills-service] Failed to read lock file:', err);
    return [];
  }
}

/**
 * List project-level skills by scanning {projectPath}/.agents/skills/
 */
export function listProjectSkills(projectPath: string): Skill[] {
  const projectSkillsDir = join(projectPath, '.claude', 'skills');
  if (!existsSync(projectSkillsDir)) return [];

  try {
    const entries = readdirSync(projectSkillsDir, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillMdPath = join(projectSkillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      const fm = parseSkillFrontmatter(skillMdPath);
      skills.push({
        name: fm.name || entry.name,
        description: fm.description || '',
        source: 'project',
        scope: 'project',
      });
    }

    return skills;
  } catch (err) {
    console.error('[skills-service] Failed to read project skills:', err);
    return [];
  }
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Install a skill via `npx skills add`.
 * Identifier format: owner/repo@skill-name
 */
export async function addSkill(identifier: string): Promise<void> {
  console.log(`[skills-service] Installing skill: ${identifier}`);

  try {
    await execute('npx', ['--yes', 'skills', 'add', identifier, '-g', '-y'], {
      cwd: homedir(),
      timeout: 60_000,
    });
  } catch (err: any) {
    const raw = stripAnsi(err?.stderr || err?.stdout || err?.message || String(err)).trim();
    const lines = raw.split('\n').filter((l: string) => l.trim());
    // Look for the most descriptive error line (e.g. "No matching skills found for: ...")
    const errorLine = lines.find((l: string) =>
      /no matching|not found|error|failed|invalid|does not exist/i.test(l)
    );
    const meaningful = errorLine || lines[0] || raw;
    throw new Error(`Failed to install skill "${identifier}": ${meaningful}`);
  }
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
    name: 'react-best-practices',
    description: 'React and Next.js performance optimization guidelines from Vercel',
    identifier: 'vercel-labs/agent-skills@react-best-practices',
  },
  {
    name: 'web-design-guidelines',
    description: 'UI audits for accessibility, performance, and UX standards',
    identifier: 'vercel-labs/agent-skills@web-design-guidelines',
  },
  {
    name: 'composition-patterns',
    description: 'React component API design and compound component patterns',
    identifier: 'vercel-labs/agent-skills@composition-patterns',
  },
  {
    name: 'remotion-best-practices',
    description: 'Video creation in React with Remotion',
    identifier: 'remotion-dev/skills@remotion-best-practices',
  },
  {
    name: 'frontend-design',
    description: 'Frontend design patterns and best practices',
    identifier: 'anthropics/skills@frontend-design',
  },
  {
    name: 'webapp-testing',
    description: 'Web application testing strategies and patterns',
    identifier: 'anthropics/skills@webapp-testing',
  },
  {
    name: 'mcp-builder',
    description: 'Build Model Context Protocol servers and tools',
    identifier: 'anthropics/skills@mcp-builder',
  },
];
