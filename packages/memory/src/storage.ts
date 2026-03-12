/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain subdomain-type: core
 * @domain type: infrastructure-service
 * @domain layer: infrastructure
 *
 * Git-backed filesystem storage for memory facts.
 * Each fact is a markdown file with YAML frontmatter.
 * All mutations are committed to a local git repo.
 */

import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { join, relative } from 'path';

import { Result, ResultAsync, err, ok } from 'neverthrow';

import { log } from './logger.js';
import type { MemoryFactFile, MemoryFactFrontmatter, StorageConfig, WriteLock } from './types.js';

// ─── Gray-matter import (CJS module) ────────────────────

let matter: typeof import('gray-matter');
async function getMatter() {
  if (!matter) {
    matter = (await import('gray-matter')).default as any;
  }
  return matter;
}

// ─── File-based write lock ──────────────────────────────

export function createWriteLock(memoryDir: string): WriteLock {
  const lockPath = join(memoryDir, '.lock');
  let _held = false;
  let _retries = 0;
  const MAX_RETRIES = 50;
  const RETRY_MS = 100;

  return {
    async acquire() {
      while (existsSync(lockPath) && _retries < MAX_RETRIES) {
        // Check if lock is stale (older than 30s)
        try {
          const s = await stat(lockPath);
          if (Date.now() - s.mtimeMs > 30_000) {
            await rm(lockPath, { force: true });
            break;
          }
        } catch {
          break; // lock file disappeared
        }
        _retries++;
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
      if (_retries >= MAX_RETRIES) {
        throw new Error('Memory write lock timeout — another process may be stuck');
      }
      await writeFile(lockPath, `${process.pid}:${Date.now()}`);
      _held = true;
      _retries = 0;
    },
    release() {
      if (_held) {
        try {
          const fs = require('fs');
          fs.rmSync(lockPath, { force: true });
        } catch {}
        _held = false;
      }
    },
    get held() {
      return _held;
    },
  };
}

// ─── Directory initialization ───────────────────────────

const SUBDIRS = ['project/facts', 'project/archive', 'operators', 'team', 'sessions', '.index'];

export async function initMemoryDir(config: StorageConfig): Promise<Result<void, string>> {
  const { memoryDir } = config;

  try {
    // Create directory structure
    for (const sub of SUBDIRS) {
      await mkdir(join(memoryDir, sub), { recursive: true });
    }

    // Create .gitignore for index directory
    const gitignorePath = join(memoryDir, '.gitignore');
    if (!existsSync(gitignorePath)) {
      await writeFile(gitignorePath, '.index/\n.lock\n');
    }

    // Create template files if they don't exist
    const templates: Array<[string, string]> = [
      [
        'project/CONVENTIONS.md',
        `# Project Conventions\n\nThis file is editable by humans. Agents read it but do not modify it.\nAdd your project conventions, coding standards, and rules here.\n`,
      ],
      [
        'team/ROSTER.md',
        `---\nlast_updated: ${new Date().toISOString()}\n---\n\n# Team Roster\n\n| Operator | Role | Expertise | Modules |\n|----------|------|-----------|----------|\n| (add team members here) | | | |\n`,
      ],
      [
        'team/ownership.md',
        `# Module Ownership\n\nDocument which team members own which modules here.\n`,
      ],
      [
        'team/norms.md',
        `# Team Norms\n\nDocument team norms, PR review rules, branching strategy, etc.\n`,
      ],
      [
        'project/INDEX.md',
        `# Project Memory Index\n\n_Auto-generated. Do not edit manually._\n\nNo facts recorded yet.\n`,
      ],
    ];

    for (const [path, content] of templates) {
      const fullPath = join(memoryDir, path);
      if (!existsSync(fullPath)) {
        await writeFile(fullPath, content);
      }
    }

    // Initialize git repo if not already
    if (!existsSync(join(memoryDir, '.git'))) {
      const initResult = Bun.spawnSync(['git', 'init'], { cwd: memoryDir });
      if (initResult.exitCode !== 0) {
        return err(`Failed to init git repo: ${initResult.stderr.toString()}`);
      }

      // Initial commit
      Bun.spawnSync(['git', 'add', '-A'], { cwd: memoryDir });
      Bun.spawnSync(
        ['git', 'commit', '-m', `memory: init Paisley Park for ${config.projectName}`],
        { cwd: memoryDir },
      );
    }

    return ok(undefined);
  } catch (e) {
    return err(`Failed to initialize memory directory: ${e}`);
  }
}

// ─── Fact file I/O ──────────────────────────────────────

export async function readFact(
  memoryDir: string,
  relativePath: string,
): Promise<Result<MemoryFactFile, string>> {
  const fullPath = join(memoryDir, relativePath);
  try {
    const raw = await readFile(fullPath, 'utf-8');
    const gm = await getMatter();
    const parsed = gm(raw);
    const fm = parsed.data as MemoryFactFrontmatter;
    return ok({
      frontmatter: fm,
      content: parsed.content.trim(),
      relativePath,
    });
  } catch (e) {
    return err(`Failed to read fact ${relativePath}: ${e}`);
  }
}

export async function writeFact(
  memoryDir: string,
  relativePath: string,
  frontmatter: MemoryFactFrontmatter,
  content: string,
): Promise<Result<void, string>> {
  const fullPath = join(memoryDir, relativePath);
  try {
    const gm = await getMatter();
    // gray-matter stringify expects (content, data)
    const output = gm.stringify(content, frontmatter as any);
    const dir = join(fullPath, '..');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, output);
    return ok(undefined);
  } catch (e) {
    return err(`Failed to write fact ${relativePath}: ${e}`);
  }
}

export async function moveFact(
  memoryDir: string,
  fromPath: string,
  toPath: string,
): Promise<Result<void, string>> {
  try {
    const fullFrom = join(memoryDir, fromPath);
    const fullTo = join(memoryDir, toPath);
    const dir = join(fullTo, '..');
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await rename(fullFrom, fullTo);
    return ok(undefined);
  } catch (e) {
    return err(`Failed to move fact ${fromPath} → ${toPath}: ${e}`);
  }
}

export async function deleteFact(
  memoryDir: string,
  relativePath: string,
): Promise<Result<void, string>> {
  try {
    await rm(join(memoryDir, relativePath), { force: true });
    return ok(undefined);
  } catch (e) {
    return err(`Failed to delete fact ${relativePath}: ${e}`);
  }
}

// ─── List facts ─────────────────────────────────────────

export async function listFacts(
  memoryDir: string,
  subdir: string = 'project/facts',
): Promise<Result<MemoryFactFile[], string>> {
  const dir = join(memoryDir, subdir);
  if (!existsSync(dir)) return ok([]);

  try {
    const files = await readdir(dir, { recursive: true });
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    const facts: MemoryFactFile[] = [];

    for (const file of mdFiles) {
      const relPath = join(subdir, file);
      const result = await readFact(memoryDir, relPath);
      if (result.isOk()) {
        facts.push(result.value);
      } else {
        log.warn(`Skipping unreadable fact: ${relPath}`, {
          namespace: 'memory',
          error: result.error,
        });
      }
    }

    return ok(facts);
  } catch (e) {
    return err(`Failed to list facts in ${subdir}: ${e}`);
  }
}

// ─── Git operations ─────────────────────────────────────

export function gitCommit(memoryDir: string, message: string): Result<void, string> {
  try {
    Bun.spawnSync(['git', 'add', '-A'], { cwd: memoryDir });
    const result = Bun.spawnSync(['git', 'commit', '-m', message, '--allow-empty'], {
      cwd: memoryDir,
    });
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString();
      // "nothing to commit" is not an error
      if (
        stderr.includes('nothing to commit') ||
        result.stdout.toString().includes('nothing to commit')
      ) {
        return ok(undefined);
      }
      return err(`Git commit failed: ${stderr}`);
    }
    return ok(undefined);
  } catch (e) {
    return err(`Git commit error: ${e}`);
  }
}

// ─── INDEX.md generation ────────────────────────────────

export async function regenerateIndex(memoryDir: string): Promise<Result<void, string>> {
  const factsResult = await listFacts(memoryDir, 'project/facts');
  if (factsResult.isErr()) return err(factsResult.error);

  const facts = factsResult.value
    .filter((f) => f.frontmatter.invalid_at === null)
    .sort((a, b) => {
      const da = new Date(a.frontmatter.ingested_at).getTime();
      const db = new Date(b.frontmatter.ingested_at).getTime();
      return db - da; // newest first
    });

  // Group by type
  const groups = new Map<string, typeof facts>();
  for (const fact of facts) {
    const type = fact.frontmatter.type;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)!.push(fact);
  }

  const typeLabels: Record<string, string> = {
    decision: 'Decisions',
    bug: 'Known Issues',
    pattern: 'Patterns',
    convention: 'Conventions',
    insight: 'Insights',
    context: 'Active Context',
  };

  let md = `# Project Memory Index\n\n_Auto-generated. Do not edit manually._\n\n`;
  md += `**Total active facts:** ${facts.length}\n\n`;

  for (const [type, label] of Object.entries(typeLabels)) {
    const items = groups.get(type);
    if (!items?.length) continue;

    md += `## ${label}\n\n`;
    for (const fact of items.slice(0, 20)) {
      const age = formatAge(fact.frontmatter.ingested_at);
      const tags = fact.frontmatter.tags.length > 0 ? ` [${fact.frontmatter.tags.join(', ')}]` : '';
      const firstLine = fact.content.split('\n')[0].slice(0, 120);
      md += `- **${fact.frontmatter.id}** (${age})${tags}: ${firstLine}\n`;
    }
    if (items.length > 20) {
      md += `- _...and ${items.length - 20} more_\n`;
    }
    md += '\n';
  }

  const indexPath = join(memoryDir, 'project/INDEX.md');
  try {
    await writeFile(indexPath, md);
    return ok(undefined);
  } catch (e) {
    return err(`Failed to write INDEX.md: ${e}`);
  }
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ─── Slug generation ────────────────────────────────────

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function generateFactId(): string {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const rand = Math.random().toString(36).slice(2, 6);
  return `fact-${date}-${rand}`;
}

export function factIdToPath(id: string, subdir: string = 'project/facts'): string {
  return `${subdir}/${id}.md`;
}
