/**
 * Plugin Service — reads installed Claude Code plugins.
 * Reads from ~/.claude/plugins/installed_plugins.json and
 * each plugin's .claude-plugin/plugin.json + commands/*.md.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

import type { Plugin, PluginCommand } from '@funny/shared';

import { log } from '../lib/logger.js';

const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const INSTALLED_FILE = join(PLUGINS_DIR, 'installed_plugins.json');

interface InstalledPluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}

interface PluginJson {
  name: string;
  description: string;
  author?: { name: string; email?: string };
}

/**
 * Parse YAML frontmatter from a command .md file to extract description.
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
 * Read commands from a plugin's commands/ directory.
 */
function readPluginCommands(pluginPath: string): PluginCommand[] {
  const commandsDir = join(pluginPath, 'commands');
  if (!existsSync(commandsDir)) return [];

  try {
    const entries = readdirSync(commandsDir, { withFileTypes: true });
    const commands: PluginCommand[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const name = basename(entry.name, '.md');
      const fm = parseCommandFrontmatter(join(commandsDir, entry.name));
      commands.push({
        name,
        description: fm.description || '',
      });
    }

    return commands;
  } catch {
    return [];
  }
}

/**
 * List all installed plugins by reading installed_plugins.json
 * and each plugin's metadata.
 */
export function listPlugins(): Plugin[] {
  if (!existsSync(INSTALLED_FILE)) return [];

  try {
    const raw = readFileSync(INSTALLED_FILE, 'utf-8');
    const data: InstalledPluginsFile = JSON.parse(raw);
    const plugins: Plugin[] = [];

    for (const [key, entries] of Object.entries(data.plugins)) {
      // Use the first (and typically only) entry
      const entry = entries[0];
      if (!entry) continue;

      const pluginJsonPath = join(entry.installPath, '.claude-plugin', 'plugin.json');

      let pluginMeta: PluginJson = { name: key.split('@')[0], description: '' };
      if (existsSync(pluginJsonPath)) {
        try {
          pluginMeta = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
        } catch {
          // Use default name from key
        }
      }

      const commands = readPluginCommands(entry.installPath);

      plugins.push({
        name: pluginMeta.name,
        description: pluginMeta.description || '',
        author: pluginMeta.author?.name || '',
        installed: true,
        installedAt: entry.installedAt,
        lastUpdated: entry.lastUpdated,
        commands,
      });
    }

    return plugins;
  } catch (err) {
    log.error('Failed to read installed plugins', { namespace: 'plugin-service', error: err });
    return [];
  }
}
