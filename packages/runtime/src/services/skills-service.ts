/**
 * @domain subdomain: Extensions
 * @domain subdomain-type: generic
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ClaudeBinary
 *
 * Manages Claude Code skills from ~/.agents/.skill-lock.json.
 */

import { readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { basename, join } from 'path';

import { execute } from '@funny/core/git';
import type { Skill } from '@funny/shared';

import { log } from '../lib/logger.js';

const AGENTS_DIR = join(homedir(), '.agents');
const SKILLS_DIR = join(AGENTS_DIR, 'skills');
const LOCK_FILE = join(AGENTS_DIR, '.skill-lock.json');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const INSTALLED_PLUGINS_FILE = join(PLUGINS_DIR, 'installed_plugins.json');

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
    log.error('Failed to read skill lock file', { namespace: 'skills-service', error: err });
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
    log.error('Failed to read project skills', { namespace: 'skills-service', error: err });
    return [];
  }
}

/**
 * Parse YAML frontmatter from a command .md file (commands/*.md in plugins).
 * These have `description:` but not necessarily `name:`.
 */
function parseCommandFrontmatter(mdPath: string): { description?: string } {
  if (!existsSync(mdPath)) return {};

  try {
    const content = readFileSync(mdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};

    const fm = fmMatch[1];
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    return {
      description: descMatch ? descMatch[1].trim() : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * List skills from ~/.claude/skills/ that are NOT already in the lock file
 * (lock file entries are symlinked here from ~/.agents/skills/).
 */
export function listDirectClaudeSkills(lockFileNames: Set<string>): Skill[] {
  if (!existsSync(CLAUDE_SKILLS_DIR)) return [];

  try {
    const entries = readdirSync(CLAUDE_SKILLS_DIR, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      // Skip entries already covered by the lock file
      if (lockFileNames.has(entry.name)) continue;

      const fullPath = join(CLAUDE_SKILLS_DIR, entry.name);
      const skillMdPath = join(fullPath, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      const fm = parseSkillFrontmatter(skillMdPath);
      skills.push({
        name: fm.name || entry.name,
        description: fm.description || '',
        source: 'direct',
        scope: 'global',
      });
    }

    return skills;
  } catch (err) {
    log.error('Failed to read direct Claude skills', { namespace: 'skills-service', error: err });
    return [];
  }
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<
    string,
    Array<{ installPath: string; installedAt?: string; lastUpdated?: string }>
  >;
}

/**
 * List commands and skills from installed Claude Code plugins.
 * Reads ~/.claude/plugins/installed_plugins.json and scans each plugin's
 * commands/*.md and skills/SKILL.md directories.
 */
export function listPluginCommands(): Skill[] {
  if (!existsSync(INSTALLED_PLUGINS_FILE)) return [];

  try {
    const raw = readFileSync(INSTALLED_PLUGINS_FILE, 'utf-8');
    const data: InstalledPluginsFile = JSON.parse(raw);
    const skills: Skill[] = [];

    for (const [pluginKey, installations] of Object.entries(data.plugins)) {
      if (!installations?.length) continue;

      // Use the most recent installation
      const install = installations[0];
      const installPath = install.installPath;
      if (!existsSync(installPath)) continue;

      // Read plugin name from .claude-plugin/plugin.json
      const pluginJsonPath = join(installPath, '.claude-plugin', 'plugin.json');
      let pluginName = pluginKey.split('@')[0]; // fallback: "commit-commands" from "commit-commands@claude-plugins-official"
      if (existsSync(pluginJsonPath)) {
        try {
          const pj = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
          if (pj.name) pluginName = pj.name;
        } catch {
          /* use fallback name */
        }
      }

      // Scan commands/*.md
      const commandsDir = join(installPath, 'commands');
      if (existsSync(commandsDir)) {
        try {
          const cmdEntries = readdirSync(commandsDir);
          for (const cmdFile of cmdEntries) {
            if (!cmdFile.endsWith('.md')) continue;
            const cmdName = basename(cmdFile, '.md');
            const fm = parseCommandFrontmatter(join(commandsDir, cmdFile));
            skills.push({
              name: `${pluginName}:${cmdName}`,
              description: fm.description || '',
              source: pluginName,
              installedAt: install.installedAt,
              updatedAt: install.lastUpdated,
              scope: 'global',
            });
          }
        } catch {
          /* skip unreadable commands dir */
        }
      }

      // Scan skills/*/SKILL.md
      const skillsDir = join(installPath, 'skills');
      if (existsSync(skillsDir)) {
        try {
          const skillEntries = readdirSync(skillsDir, { withFileTypes: true });
          for (const entry of skillEntries) {
            if (!entry.isDirectory()) continue;
            const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
            if (!existsSync(skillMdPath)) continue;

            const fm = parseSkillFrontmatter(skillMdPath);
            skills.push({
              name: `${pluginName}:${fm.name || entry.name}`,
              description: fm.description || '',
              source: pluginName,
              installedAt: install.installedAt,
              updatedAt: install.lastUpdated,
              scope: 'global',
            });
          }
        } catch {
          /* skip unreadable skills dir */
        }
      }
    }

    return skills;
  } catch (err) {
    log.error('Failed to read plugin commands', { namespace: 'skills-service', error: err });
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
 * Install a skill via `bunx skills add`.
 * Identifier format: owner/repo@skill-name
 */
export async function addSkill(identifier: string): Promise<void> {
  log.info('Installing skill', { namespace: 'skills-service', identifier });

  try {
    await execute('bunx', ['skills', 'add', identifier, '-g', '-y'], {
      cwd: homedir(),
      timeout: 60_000,
    });
  } catch (err: any) {
    const raw = stripAnsi(err?.stderr || err?.stdout || err?.message || String(err)).trim();
    const lines = raw.split('\n').filter((l: string) => l.trim());
    // Look for the most descriptive error line (e.g. "No matching skills found for: ...")
    const errorLine = lines.find((l: string) =>
      /no matching|not found|error|failed|invalid|does not exist/i.test(l),
    );
    const meaningful = errorLine || lines[0] || raw;
    throw new Error(`Failed to install skill "${identifier}": ${meaningful}`, { cause: err });
  }
}

/**
 * Remove a skill by deleting its directory and symlink,
 * and updating the lock file.
 */
export function removeSkill(name: string): void {
  log.info('Removing skill', { namespace: 'skills-service', name });

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
      log.error('Failed to update skill lock file', { namespace: 'skills-service', error: err });
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
    identifier: 'vercel-labs/agent-skills@vercel-react-best-practices',
  },
  {
    name: 'web-design-guidelines',
    description: 'UI audits for accessibility, performance, and UX standards',
    identifier: 'vercel-labs/agent-skills@web-design-guidelines',
  },
  {
    name: 'composition-patterns',
    description: 'React component API design and compound component patterns',
    identifier: 'vercel-labs/agent-skills@vercel-composition-patterns',
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
