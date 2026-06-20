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
import type { AgentResource, Skill } from '@funny/shared';
import { type DomainError, processError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { log } from '../lib/logger.js';

const AGENTS_DIR = join(homedir(), '.agents');
const SKILLS_DIR = join(AGENTS_DIR, 'skills');
const LOCK_FILE = join(AGENTS_DIR, '.skill-lock.json');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const INSTALLED_PLUGINS_FILE = join(PLUGINS_DIR, 'installed_plugins.json');
const CODEX_SKILLS_DIR = join(homedir(), '.codex', 'skills');

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
      // Accept both real directories and symlinks (skills CLI creates symlinks)
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

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

function listCommandFiles(commandsDir: string, prefix = ''): Skill[] {
  const commands: Skill[] = [];
  const entries = readdirSync(commandsDir, { withFileTypes: true });

  for (const entry of entries) {
    const segment = prefix ? `${prefix}:${entry.name}` : entry.name;
    const fullPath = join(commandsDir, entry.name);

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (existsSync(fullPath)) {
        commands.push(...listCommandFiles(fullPath, segment));
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const cmdName = segment.slice(0, -'.md'.length);
    const fm = parseCommandFrontmatter(fullPath);
    commands.push({
      name: cmdName,
      description: fm.description || '',
      source: 'project',
      scope: 'project',
    });
  }

  return commands;
}

/**
 * List project-level slash commands by scanning {projectPath}/.claude/commands.
 * Nested directories are exposed using Claude Code's namespace syntax:
 * commands/opsx/apply.md => /opsx:apply.
 */
export function listProjectCommands(projectPath: string): Skill[] {
  const projectCommandsDir = join(projectPath, '.claude', 'commands');
  if (!existsSync(projectCommandsDir)) return [];

  try {
    return listCommandFiles(projectCommandsDir);
  } catch (err) {
    log.error('Failed to read project commands', { namespace: 'skills-service', error: err });
    return [];
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
      // Accept both real directories and symlinks (skills CLI creates symlinks)
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
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

// ─── Agent Resources (provider-tagged) ───────────────────
//
// The functions above return undifferentiated `Skill[]` that conflate
// model-invoked skills with user-invoked slash commands. The functions below
// produce `AgentResource[]` with explicit `kind`, `origin`, `commandTier`, and
// Claude-only compatibility — the input the provider-scoped resolver needs.
// All of these are CLAUDE-owned filesystem resources.

const CLAUDE_ONLY: AgentResource['compatibleProviders'] = ['claude'];
const CODEX_ONLY: AgentResource['compatibleProviders'] = ['codex'];

/**
 * Provider-general entry point used by the resolver: returns the filesystem
 * SKILLS owned by `provider`. Claude reuses its lock-file/plugin-aware path;
 * Codex scans both Codex's legacy `.codex/skills` folders and the shared
 * agent-skills folders (`.agents/skills`). Providers with no filesystem skill
 * concept return [].
 */
export function listSkillResourcesForProvider(
  provider: string,
  projectPath?: string,
): AgentResource[] {
  if (provider === 'claude') return listClaudeSkillResources(projectPath);
  if (provider === 'codex') return listCodexSkillResources(projectPath);
  return [];
}

/**
 * Provider-general entry point: returns the filesystem CUSTOM slash commands
 * owned by `provider`. Only Claude has a filesystem custom-command location
 * (.claude/commands) in v1; every other provider's commands come from its
 * live session instead.
 */
export function listCustomCommandResourcesForProvider(
  provider: string,
  projectPath?: string,
): AgentResource[] {
  if (provider === 'claude') return listClaudeCustomCommandResources(projectPath);
  return [];
}

/**
 * Recursively collect Codex skills (folders containing a SKILL.md) under a root.
 * Codex nests built-ins under `.system/`, so a flat one-level scan misses them;
 * we walk a bounded depth and stop descending once a SKILL.md is found.
 */
function scanCodexSkillsTree(
  rootDir: string,
  origin: AgentResource['origin'],
  scope: 'global' | 'project',
): AgentResource[] {
  if (!existsSync(rootDir)) return [];
  const out: AgentResource[] = [];

  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    const skillMd = join(dir, 'SKILL.md');
    if (existsSync(skillMd)) {
      const fm = parseSkillFrontmatter(skillMd);
      out.push({
        kind: 'skill',
        name: fm.name || basename(dir),
        description: fm.description || '',
        origin,
        compatibleProviders: CODEX_ONLY,
        usable: true,
        scope,
      });
      return; // a skill folder owns its subtree — don't descend into it
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        walk(join(dir, entry.name), depth + 1);
      }
    }
  };

  walk(rootDir, 0);
  return out;
}

/**
 * All Codex skills (model-invoked) from:
 * - ~/.codex/skills and {project}/.codex/skills
 * - ~/.agents/skills and {project}/.agents/skills
 */
export function listCodexSkillResources(projectPath?: string): AgentResource[] {
  const resources = scanCodexSkillsTree(CODEX_SKILLS_DIR, 'codex-global', 'global');
  resources.push(...scanCodexSkillsTree(SKILLS_DIR, 'codex-global', 'global'));
  if (projectPath) {
    resources.push(
      ...scanCodexSkillsTree(join(projectPath, '.codex', 'skills'), 'codex-project', 'project'),
      ...scanCodexSkillsTree(join(projectPath, '.agents', 'skills'), 'codex-project', 'project'),
    );
  }
  return resources;
}

/**
 * All Claude skills (model-invoked) from every filesystem source — lock file,
 * direct ~/.claude/skills, project .claude/skills, and plugin skills/ dirs.
 */
export function listClaudeSkillResources(projectPath?: string): AgentResource[] {
  const lockFileSkills = listSkills();
  const lockFileNames = new Set(lockFileSkills.map((s) => s.name));
  const directSkills = listDirectClaudeSkills(lockFileNames);
  const projectSkills = projectPath ? listProjectSkills(projectPath) : [];

  const resources: AgentResource[] = [];
  for (const s of lockFileSkills) {
    resources.push(skillToResource(s, 'skill', 'claude-global'));
  }
  for (const s of directSkills) {
    resources.push(skillToResource(s, 'skill', 'claude-global'));
  }
  for (const s of projectSkills) {
    resources.push(skillToResource(s, 'skill', 'claude-project'));
  }
  for (const r of scanPluginResources()) {
    if (r.kind === 'skill') resources.push(r);
  }
  return resources;
}

/**
 * Claude CUSTOM slash commands (user-authored): project .claude/commands plus
 * plugin commands/ dirs. Built-in commands are NOT here — they come from the
 * live session, never the filesystem.
 */
export function listClaudeCustomCommandResources(projectPath?: string): AgentResource[] {
  const resources: AgentResource[] = [];
  const projectCommands = projectPath ? listProjectCommands(projectPath) : [];
  for (const c of projectCommands) {
    resources.push(skillToResource(c, 'slash-command', 'claude-project', 'custom'));
  }
  for (const r of scanPluginResources()) {
    if (r.kind === 'slash-command') resources.push(r);
  }
  return resources;
}

function skillToResource(
  s: Skill,
  kind: AgentResource['kind'],
  origin: AgentResource['origin'],
  commandTier?: AgentResource['commandTier'],
): AgentResource {
  return {
    kind,
    name: s.name,
    description: s.description,
    origin,
    compatibleProviders: CLAUDE_ONLY,
    usable: true,
    commandTier,
    scope: s.scope,
    sourceUrl: s.sourceUrl,
    installedAt: s.installedAt,
    updatedAt: s.updatedAt,
  };
}

/**
 * Scan installed Claude plugins, tagging each entry as a `slash-command`
 * (commands/*.md) or `skill` (skills/SKILL.md). Mirrors {@link listPluginCommands}
 * but keeps the two kinds distinct instead of flattening both into `Skill[]`.
 */
function scanPluginResources(): AgentResource[] {
  if (!existsSync(INSTALLED_PLUGINS_FILE)) return [];

  try {
    const raw = readFileSync(INSTALLED_PLUGINS_FILE, 'utf-8');
    const data: InstalledPluginsFile = JSON.parse(raw);
    const resources: AgentResource[] = [];

    for (const [pluginKey, installations] of Object.entries(data.plugins)) {
      if (!installations?.length) continue;
      const install = installations[0];
      const installPath = install.installPath;
      if (!existsSync(installPath)) continue;

      const pluginJsonPath = join(installPath, '.claude-plugin', 'plugin.json');
      let pluginName = pluginKey.split('@')[0];
      if (existsSync(pluginJsonPath)) {
        try {
          const pj = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
          if (pj.name) pluginName = pj.name;
        } catch {
          /* use fallback name */
        }
      }

      const commandsDir = join(installPath, 'commands');
      if (existsSync(commandsDir)) {
        try {
          for (const cmdFile of readdirSync(commandsDir)) {
            if (!cmdFile.endsWith('.md')) continue;
            const cmdName = basename(cmdFile, '.md');
            const fm = parseCommandFrontmatter(join(commandsDir, cmdFile));
            resources.push({
              kind: 'slash-command',
              name: `${pluginName}:${cmdName}`,
              description: fm.description || '',
              origin: 'claude-plugin',
              compatibleProviders: CLAUDE_ONLY,
              usable: true,
              commandTier: 'custom',
              scope: 'global',
              installedAt: install.installedAt,
              updatedAt: install.lastUpdated,
            });
          }
        } catch {
          /* skip unreadable commands dir */
        }
      }

      const skillsDir = join(installPath, 'skills');
      if (existsSync(skillsDir)) {
        try {
          for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
            if (!existsSync(skillMdPath)) continue;
            const fm = parseSkillFrontmatter(skillMdPath);
            resources.push({
              kind: 'skill',
              name: `${pluginName}:${fm.name || entry.name}`,
              description: fm.description || '',
              origin: 'claude-plugin',
              compatibleProviders: CLAUDE_ONLY,
              usable: true,
              scope: 'global',
              installedAt: install.installedAt,
              updatedAt: install.lastUpdated,
            });
          }
        } catch {
          /* skip unreadable skills dir */
        }
      }
    }

    return resources;
  } catch (err) {
    log.error('Failed to scan plugin resources', { namespace: 'skills-service', error: err });
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
export function addSkill(identifier: string): ResultAsync<void, DomainError> {
  log.info('Installing skill', { namespace: 'skills-service', identifier });

  return ResultAsync.fromPromise(
    execute('bunx', ['skills', 'add', identifier, '-g', '-y'], {
      cwd: homedir(),
      timeout: 60_000,
    }).then(() => {}),
    (err: unknown) => {
      const e = err as any;
      const raw = stripAnsi(e?.stderr || e?.stdout || e?.message || String(e)).trim();
      const lines = raw.split('\n').filter((l: string) => l.trim());
      const errorLine = lines.find((l: string) =>
        /no matching|not found|error|failed|invalid|does not exist/i.test(l),
      );
      const meaningful = errorLine || lines[0] || raw;
      return processError(`Failed to install skill "${identifier}": ${meaningful}`, 1, '');
    },
  );
}

/**
 * Remove a skill by deleting its directory and symlink,
 * and updating the lock file.
 */
export function removeSkill(name: string): void {
  // Security: `name` comes straight from the DELETE /:name URL param and is
  // join()'d against SKILLS_DIR / CLAUDE_SKILLS_DIR before a recursive rmSync.
  // A traversal segment (e.g. `..%2f..%2f.funny%2fencryption.key`) would
  // otherwise let an authenticated request delete arbitrary runner-writable
  // files. Restrict to the same whitelist used elsewhere for ids.
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    log.warn('Rejected removeSkill with invalid name', { namespace: 'skills-service', name });
    return;
  }

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
