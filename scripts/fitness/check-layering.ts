#!/usr/bin/env bun
/**
 * Fitness function: package-layering rules.
 *
 * Rules:
 *  - packages/server/** must not import from @funny/runtime
 *  - packages/core/**   must not import hono or drizzle-orm
 *  - packages/shared/** must not import from @funny/core or @funny/runtime
 *  - packages/client-core/** must not depend on browser, DOM, Tauri, Vite, or web renderers
 *  - packages/client-benchmark/** must remain renderer-neutral and DOM-free
 *  - packages/client-gpuix/** must not depend on web renderer APIs
 *
 * Exits non-zero on violation.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

type Rule = {
  name: string;
  pkgDir: string;
  forbidden: RegExp;
};

const RULES: Rule[] = [
  {
    name: 'server must not import @funny/runtime',
    pkgDir: 'packages/server/src',
    forbidden: /from\s+['"]@funny\/runtime(\/|['"])/,
  },
  {
    name: 'core must not import hono',
    pkgDir: 'packages/core/src',
    forbidden: /from\s+['"]hono(\/|['"])/,
  },
  {
    name: 'core must not import drizzle-orm',
    pkgDir: 'packages/core/src',
    forbidden: /from\s+['"]drizzle-orm(\/|['"])/,
  },
  {
    name: 'shared must not import @funny/core',
    pkgDir: 'packages/shared/src',
    forbidden: /from\s+['"]@funny\/core(\/|['"])/,
  },
  {
    name: 'shared must not import @funny/runtime',
    pkgDir: 'packages/shared/src',
    forbidden: /from\s+['"]@funny\/runtime(\/|['"])/,
  },
  {
    name: 'client-core must not import renderer packages',
    pkgDir: 'packages/client-core/src',
    forbidden:
      /(?:from\s+|import\s*\()['"](?:@funny\/client(?:\/|['"])|react(?:-dom)?(?:\/|['"])|@tauri-apps\/|@vitejs\/|vite(?:\/|['"])|sonner(?:\/|['"])|socket\.io-client(?:\/|['"]))/,
  },
  {
    name: 'client-core must not use browser or DOM globals/types',
    pkgDir: 'packages/client-core/src',
    forbidden:
      /\b(?:window|document|localStorage|sessionStorage|navigator|HTMLElement|Element|Node|ResizeObserver|IntersectionObserver|MutationObserver|CustomEvent|Notification)\b/,
  },
  {
    name: 'ui-contracts must not import renderer packages',
    pkgDir: 'packages/ui-contracts/src',
    forbidden:
      /(?:from\s+|import\s*\()['"](?:@funny\/(?:client|gpuix-ui)(?:\/|['"])|@gpuix\/|react(?:-dom)?(?:\/|['"])|@radix-ui\/|vite(?:\/|['"]))/,
  },
  {
    name: 'ui-contracts must not use browser or DOM globals/types',
    pkgDir: 'packages/ui-contracts/src',
    forbidden:
      /\b(?:window|document|localStorage|sessionStorage|navigator|HTMLElement|Element|Node|ResizeObserver|IntersectionObserver|MutationObserver|CustomEvent|Notification)\b/,
  },
  {
    name: 'client-gpuix must not import web renderer packages',
    pkgDir: 'packages/client-gpuix/src',
    forbidden:
      /(?:from\s+|import\s*\()['"](?:@funny\/client(?:\/|['"])|react-dom(?:\/|['"])|react-router-dom(?:\/|['"])|@tauri-apps\/|@radix-ui\/|dockview(?:\/|['"])|monaco-editor(?:\/|['"])|@xterm\/|sonner(?:\/|['"]))/,
  },
  {
    name: 'client-gpuix must not use browser or DOM globals/types',
    pkgDir: 'packages/client-gpuix/src',
    forbidden:
      /\b(?:window|document|localStorage|sessionStorage|navigator|HTMLElement|ResizeObserver|IntersectionObserver|MutationObserver|CustomEvent|Notification)\b/,
  },
  {
    name: 'client-benchmark must not import renderer packages',
    pkgDir: 'packages/client-benchmark/src',
    forbidden:
      /(?:from\s+|import\s*\()['"](?:@funny\/client(?:\/|['"])|@gpuix\/|react(?:-dom)?(?:\/|['"])|@tauri-apps\/|@vitejs\/|vite(?:\/|['"])|playwright(?:\/|['"]))/,
  },
  {
    name: 'client-benchmark must not use browser or DOM globals/types',
    pkgDir: 'packages/client-benchmark/src',
    forbidden:
      /\b(?:window|document|localStorage|sessionStorage|navigator|HTMLElement|Element|Node|ResizeObserver|IntersectionObserver|MutationObserver|CustomEvent|Notification)\b/,
  },
];

function findViolations(source: string, rule: Rule, file = 'fixture.ts'): string[] {
  const found: string[] = [];
  source.split('\n').forEach((line, index) => {
    if (rule.forbidden.test(line)) {
      found.push(`[${rule.name}] ${file}:${index + 1}  ${line.trim()}`);
    }
  });
  return found;
}

function runSelfTest(): void {
  const portableRules = RULES.filter(
    (rule) =>
      rule.pkgDir === 'packages/client-core/src' || rule.pkgDir === 'packages/client-benchmark/src',
  );
  const allowed = [
    "import type { Thread } from '@funny/shared';",
    'const location = { pathname: "/" };',
    'export interface StorageService { read(key: string): string | null }',
  ];
  const forbidden = [
    "import { toast } from 'sonner';",
    "import React from 'react';",
    "import { invoke } from '@tauri-apps/api/core';",
    'const path = window.location.pathname;',
    'const root: HTMLElement | null = null;',
    'new ResizeObserver(() => undefined);',
  ];

  for (const source of allowed) {
    if (portableRules.some((rule) => findViolations(source, rule).length > 0)) {
      throw new Error(`layering self-test rejected allowed source: ${source}`);
    }
  }
  for (const source of forbidden) {
    if (!portableRules.some((rule) => findViolations(source, rule).length > 0)) {
      throw new Error(`layering self-test accepted forbidden source: ${source}`);
    }
  }
  console.log('layering self-test ok — allowed and forbidden fixtures classified correctly');
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

const violations: string[] = [];

for (const rule of RULES) {
  const abs = join(ROOT, rule.pkgDir);
  try {
    for (const file of walk(abs)) {
      const text = readFileSync(file, 'utf8');
      violations.push(...findViolations(text, rule, relative(ROOT, file)));
    }
  } catch {
    // dir missing — skip
  }
}

if (process.argv.includes('--self-test')) runSelfTest();

if (violations.length > 0) {
  console.error('Layering violations:\n');
  for (const v of violations) console.error('  ' + v);
  console.error(`\n${violations.length} violation(s)`);
  process.exit(1);
}

console.log('layering ok — all package boundaries respected');
