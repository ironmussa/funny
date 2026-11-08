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
import { basename, dirname, join } from 'path';

import { execute } from '@funny/core/git';
import type { AgentResource, Skill } from '@funny/shared';
import { type DomainError, processError } from '@funny/shared/errors';
import { parseStoredJson } from '@funny/shared/json-validation';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { defaultClaudeConfigDir, normalizeClaudeConfigDir } from '../utils/claude-profile-paths.js';

const AGENTS_DIR = join(homedir(), '.agents');
const SKILLS_DIR = join(AGENTS_DIR, 'skills');
const LOCK_FILE = join(AGENTS_DIR, '.skill-lock.json');
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills');
const CODEX_SKILLS_DIR = join(homedir(), '.codex', 'skills');

interface ClaudeResourceScanOptions {
  claudeConfigDir?: string;
}

function claudeConfigDir(options: ClaudeResourceScanOptions = {}): string {
  return normalizeClaudeConfigDir(options.claudeConfigDir) ?? defaultClaudeConfigDir();
}

function claudeSkillsDir(options: ClaudeResourceScanOptions = {}): string {
  return join(claudeConfigDir(options), 'skills');
}

function installedPluginsFile(options: ClaudeResourceScanOptions = {}): string {
  return join(claudeConfigDir(options), 'plugins', 'installed_plugins.json');
}

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
function parseThreadMode(value: string | undefined): 'local' | 'worktree' | undefined {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, '');
  return normalized === 'local' || normalized === 'worktree' ? normalized : undefined;
}

function parseCommandFrontmatter(mdPath: string): {
  description?: string;
  threadMode?: 'local' | 'worktree';
} {
  if (!existsSync(mdPath)) return {};

  try {
    const content = readFileSync(mdPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};

    const fm = fmMatch[1];
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    const threadModeMatch = fm.match(/^(?:thread-mode|threadMode):\s*(.+)$/m);
    return {
      description: descMatch ? descMatch[1].trim() : undefined,
      threadMode: parseThreadMode(threadModeMatch?.[1]),
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
      threadMode: fm.threadMode,
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
export function listDirectClaudeSkills(
  lockFileNames: Set<string>,
  options: ClaudeResourceScanOptions = {},
): Skill[] {
  const skillsDir = claudeSkillsDir(options);
  if (!existsSync(skillsDir)) return [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skills: Skill[] = [];

    for (const entry of entries) {
      // Accept both real directories and symlinks (skills CLI creates symlinks)
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      // Skip entries already covered by the lock file
      if (lockFileNames.has(entry.name)) continue;

      const fullPath = join(skillsDir, entry.name);
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

interface PluginLayout {
  name: string;
  /** Absolute paths to each command `.md` file. */
  commandFiles: string[];
  /** Absolute paths to each skill's `SKILL.md`. */
  skillFiles: string[];
}

/** Manifest path fields accept a single string or an array of strings. */
const manifestPathsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .catch(undefined)
  .transform((v) => (v === undefined ? [] : typeof v === 'string' ? [v] : v));

/** The parts of `.claude-plugin/plugin.json` we read; a bad field is ignored. */
const pluginManifestSchema = z.object({
  name: z.string().optional().catch(undefined),
  commands: manifestPathsSchema,
  skills: manifestPathsSchema,
});

/** `dir/*.md` (non-recursive). */
function mdFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** A skill dir (`dir/SKILL.md`) or a folder of skill dirs (`dir/<skill>/SKILL.md`). */
function skillFilesIn(dir: string): string[] {
  const own = join(dir, 'SKILL.md');
  if (existsSync(own)) return [own];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name, 'SKILL.md'))
      .filter((f) => existsSync(f));
  } catch {
    return [];
  }
}

/**
 * Resolve a plugin's name and the files of its commands and skills. Mirrors
 * Claude Code: the default `commands/` and `skills/` folders are always scanned,
 * and `commands` / `skills` paths in `.claude-plugin/plugin.json` add to them
 * (e.g. nested layouts like `./skills/engineering/implement`).
 */
function readPluginLayout(installPath: string, pluginKey: string): PluginLayout {
  const manifest = readPluginManifest(installPath, pluginKey);
  return {
    name: manifest.name,
    commandFiles: collectCommandFiles(installPath, manifest.commands),
    skillFiles: collectSkillFiles(installPath, manifest.skills),
  };
}

/** `.claude-plugin/plugin.json`, or the fallback name and no extra paths when absent or invalid. */
function readPluginManifest(
  installPath: string,
  pluginKey: string,
): { name: string; commands: string[]; skills: string[] } {
  // fallback: "commit-commands" from "commit-commands@claude-plugins-official"
  const fallback = { name: pluginKey.split('@')[0], commands: [], skills: [] };
  const pluginJsonPath = join(installPath, '.claude-plugin', 'plugin.json');
  if (!existsSync(pluginJsonPath)) return fallback;
  try {
    const parsed = parseStoredJson(
      pluginManifestSchema,
      readFileSync(pluginJsonPath, 'utf-8'),
      'plugin.json',
    );
    if (!parsed.ok) return fallback;
    return { ...parsed.value, name: parsed.value.name || fallback.name };
  } catch {
    /* unreadable manifest: use fallback name and default folders */
    return fallback;
  }
}

/** Default `commands/*.md` plus each manifest path (a `.md` file or a folder of them). */
function collectCommandFiles(installPath: string, manifestPaths: string[]): string[] {
  const files = new Set(mdFilesIn(join(installPath, 'commands')));
  for (const rel of manifestPaths) {
    const abs = join(installPath, rel);
    const found = abs.endsWith('.md') ? [abs].filter((f) => existsSync(f)) : mdFilesIn(abs);
    for (const f of found) files.add(f);
  }
  return [...files];
}

/** Default `skills/` folder plus each manifest path, de-duplicated in order. */
function collectSkillFiles(installPath: string, manifestPaths: string[]): string[] {
  const dirs = ['skills', ...manifestPaths].map((rel) => join(installPath, rel));
  return [...new Set(dirs.flatMap(skillFilesIn))];
}

/** Most recent installation of each installed plugin that still exists on disk, with its layout. */
function* installedPluginLayouts(
  data: InstalledPluginsFile,
): Generator<{ install: InstalledPluginsFile['plugins'][string][number]; plugin: PluginLayout }> {
  for (const [pluginKey, installations] of Object.entries(data.plugins)) {
    if (!installations?.length) continue;
    // Use the most recent installation
    const install = installations[0];
    if (!existsSync(install.installPath)) continue;
    yield { install, plugin: readPluginLayout(install.installPath, pluginKey) };
  }
}

/**
 * List commands and skills from installed Claude Code plugins.
 * Reads ~/.claude/plugins/installed_plugins.json and resolves each plugin's
 * commands and skills via {@link readPluginLayout}.
 */
export function listPluginCommands(options: ClaudeResourceScanOptions = {}): Skill[] {
  const pluginsFile = installedPluginsFile(options);
  if (!existsSync(pluginsFile)) return [];

  try {
    const raw = readFileSync(pluginsFile, 'utf-8');
    const data: InstalledPluginsFile = JSON.parse(raw);
    const skills: Skill[] = [];

    for (const { install, plugin } of installedPluginLayouts(data)) {
      for (const cmdPath of plugin.commandFiles) {
        const fm = parseCommandFrontmatter(cmdPath);
        skills.push({
          name: `${plugin.name}:${basename(cmdPath, '.md')}`,
          description: fm.description || '',
          source: plugin.name,
          installedAt: install.installedAt,
          updatedAt: install.lastUpdated,
          scope: 'global',
          threadMode: fm.threadMode,
        });
      }

      for (const skillMdPath of plugin.skillFiles) {
        const fm = parseSkillFrontmatter(skillMdPath);
        skills.push({
          name: `${plugin.name}:${fm.name || basename(dirname(skillMdPath))}`,
          description: fm.description || '',
          source: plugin.name,
          installedAt: install.installedAt,
          updatedAt: install.lastUpdated,
          scope: 'global',
        });
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
  options: ClaudeResourceScanOptions = {},
): AgentResource[] {
  if (provider === 'claude') return listClaudeSkillResources(projectPath, options);
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
  options: ClaudeResourceScanOptions = {},
): AgentResource[] {
  if (provider === 'claude') return listClaudeCustomCommandResources(projectPath, options);
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
function listClaudeSkillResources(
  projectPath?: string,
  options: ClaudeResourceScanOptions = {},
): AgentResource[] {
  const lockFileSkills = listSkills();
  const lockFileNames = new Set(lockFileSkills.map((s) => s.name));
  const directSkills = listDirectClaudeSkills(lockFileNames, options);
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
  for (const r of scanPluginResources(options)) {
    if (r.kind === 'skill') resources.push(r);
  }
  return resources;
}

/**
 * Claude CUSTOM slash commands (user-authored): project .claude/commands plus
 * plugin commands/ dirs. Built-in commands are NOT here — they come from the
 * live session, never the filesystem.
 */
function listClaudeCustomCommandResources(
  projectPath?: string,
  options: ClaudeResourceScanOptions = {},
): AgentResource[] {
  const resources: AgentResource[] = [];
  const projectCommands = projectPath ? listProjectCommands(projectPath) : [];
  for (const c of projectCommands) {
    resources.push(skillToResource(c, 'slash-command', 'claude-project', 'custom'));
  }
  for (const r of scanPluginResources(options)) {
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
    threadMode: kind === 'slash-command' ? s.threadMode : undefined,
  };
}

/**
 * Scan installed Claude plugins, tagging each entry as a `slash-command`
 * or `skill`, using the same {@link readPluginLayout} file resolution. Mirrors {@link listPluginCommands}
 * but keeps the two kinds distinct instead of flattening both into `Skill[]`.
 */
function scanPluginResources(options: ClaudeResourceScanOptions = {}): AgentResource[] {
  const pluginsFile = installedPluginsFile(options);
  if (!existsSync(pluginsFile)) return [];

  try {
    const raw = readFileSync(pluginsFile, 'utf-8');
    const data: InstalledPluginsFile = JSON.parse(raw);
    const resources: AgentResource[] = [];

    for (const { install, plugin } of installedPluginLayouts(data)) {
      for (const cmdPath of plugin.commandFiles) {
        const fm = parseCommandFrontmatter(cmdPath);
        resources.push({
          kind: 'slash-command',
          name: `${plugin.name}:${basename(cmdPath, '.md')}`,
          description: fm.description || '',
          origin: 'claude-plugin',
          compatibleProviders: CLAUDE_ONLY,
          usable: true,
          commandTier: 'custom',
          scope: 'global',
          installedAt: install.installedAt,
          updatedAt: install.lastUpdated,
          threadMode: fm.threadMode,
        });
      }

      for (const skillMdPath of plugin.skillFiles) {
        const fm = parseSkillFrontmatter(skillMdPath);
        resources.push({
          kind: 'skill',
          name: `${plugin.name}:${fm.name || basename(dirname(skillMdPath))}`,
          description: fm.description || '',
          origin: 'claude-plugin',
          compatibleProviders: CLAUDE_ONLY,
          usable: true,
          scope: 'global',
          installedAt: install.installedAt,
          updatedAt: install.lastUpdated,
        });
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
  const ansiColorPattern = new RegExp(String.raw`\u001B\[[0-9;]*m`, 'g');
  const ansiPrivateModePattern = new RegExp(String.raw`\u001B\[\?[0-9;]*[a-zA-Z]`, 'g');

  return str.replace(ansiColorPattern, '').replace(ansiPrivateModePattern, '');
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
