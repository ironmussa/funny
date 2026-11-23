#!/usr/bin/env bun
/**
 * Fitness function: client UI follows the font size setting and the theme
 * (CLAUDE.md, "Respect the global font size setting and theme"; issue #229).
 *
 * Fails, in `packages/client/src` (tests and stories exempt), on:
 * - `text-[Npx]`: a pixel font size ignores Settings > Appearance. Use the rem
 *   steps (`text-4xs` … `text-compact`, `text-xs`, …) or the `*_FONT_SIZE_PX`
 *   scales from `stores/settings-store`.
 * - `fontSize: 12` / `fontSize: '12px'`: same, in a style or chart prop.
 * - A Tailwind arbitrary color (`text-[#fafafa]`, `bg-[rgb(…)]`) or an inline
 *   `color` / `backgroundColor` / `fill` / `stroke` literal: use a theme class
 *   or variable (`text-foreground`, `var(--terminal-green)`, …).
 * - `defineTheme(` outside `lib/monaco-theme.ts`: Monaco themes are global, so
 *   a second definition of a name changes every editor that uses it.
 *
 * A deliberate exception carries `ui-rules-allow: <reason>` in a comment on
 * the same line or the line above. Exits non-zero on violation;
 * `--self-test` checks the fixtures.
 */

import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { walkSources } from './walk-sources';

const ROOT = join(import.meta.dir, '..', '..');
const SCANNED = 'packages/client/src';
const MONACO_THEME_OWNER = 'packages/client/src/lib/monaco-theme.ts';
const ALLOW = 'ui-rules-allow:';

const COLOR_UTILITY =
  '(?:bg|text|border(?:-[trblxy])?|fill|stroke|ring|outline|decoration|from|via|to|shadow|caret|accent|divide|placeholder)';

interface Rule {
  pattern: RegExp;
  message: string;
  appliesTo?: (file: string) => boolean;
}

const RULES: Rule[] = [
  {
    pattern: /\btext-\[\d+(?:\.\d+)?px\]/g,
    message:
      'pixel font size; use text-4xs / text-3xs / text-2xs / text-compact / text-xs … (rem, follows the font size setting)',
  },
  {
    pattern: /\bfontSize:\s*(?:\d|['"`]\d+(?:\.\d+)?px['"`])/g,
    message:
      'pixel font size; use a rem value or the *_FONT_SIZE_PX scales in stores/settings-store',
  },
  {
    pattern: new RegExp(`\\b${COLOR_UTILITY}-\\[(?:#|rgba?\\(|hsla?\\(\\d)`, 'g'),
    message: 'hardcoded color class; use a theme class or a theme variable',
  },
  {
    pattern:
      /\b(?:color|backgroundColor|background|borderColor|fill|stroke):\s*['"`](?:#[0-9a-fA-F]{3,8}|rgba?\(|black\b|white\b)/g,
    message: 'hardcoded inline color; use a theme variable (hsl(var(--…)) / var(--…))',
  },
  {
    pattern: /\bdefineTheme\s*\(/g,
    message: `Monaco theme defined outside ${MONACO_THEME_OWNER}; use defineFunnyDarkTheme / monacoThemeFor`,
    appliesTo: (file) => file !== MONACO_THEME_OWNER,
  },
];

function stripComments(source: string): string {
  // Keep line count: blank out the comment text, not the newlines.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, lead: string) => lead + ' '.repeat(c.length - lead.length));
}

/** Violations for one source file (repo-relative path). */
export function classify(file: string, source: string): string[] {
  const rawLines = source.split('\n');
  const code = stripComments(source);
  const violations: string[] = [];
  for (const rule of RULES) {
    if (rule.appliesTo && !rule.appliesTo(file)) continue;
    for (const match of code.matchAll(rule.pattern)) {
      const line = code.slice(0, match.index).split('\n').length;
      const allowed =
        rawLines[line - 1]?.includes(ALLOW) || (line > 1 && rawLines[line - 2]?.includes(ALLOW));
      if (allowed) continue;
      violations.push(`${file}:${line}: \`${match[0]}\` — ${rule.message}`);
    }
  }
  return violations;
}

function runSelfTest(): void {
  const file = 'packages/client/src/components/X.tsx';
  const allowed: Array<[string, string]> = [
    [file, '<span className="text-2xs text-muted-foreground" />'],
    [file, '<span className="text-[length:var(--diff-font-size)]" />'],
    [file, "const s = { fontSize: '0.75rem', fill: 'hsl(var(--muted-foreground))' };"],
    [file, 'fontSize: EDITOR_FONT_SIZE_PX[size],'],
    [file, '<span className="text-[var(--terminal-green)]" />'],
    [file, "// text-[10px] used to be here\nconst a = 'https://x.dev/#a';"],
    [file, "// ui-rules-allow: iOS zoom\nmobile && 'text-[16px]',"],
    [file, "mobile && 'text-[16px]', // ui-rules-allow: iOS zoom"],
    [MONACO_THEME_OWNER, "monaco.editor.defineTheme('funny-dark', data);"],
    [file, 'const project = { color: project.color };'],
  ];
  const forbidden: Array<[string, string, string]> = [
    [file, '<span className="text-[10px]" />', 'text-[10px]'],
    [file, '<span className="text-[11.5px] font-mono" />', 'text-[11.5px]'],
    [file, 'tick={{ fontSize: 11 }}', 'fontSize: 1'],
    [file, "wrapperStyle={{ fontSize: '12px' }}", "fontSize: '12px'"],
    [file, '<pre className="text-[#fafafa]" />', 'text-[#'],
    [file, '<div className="bg-[#1e1e2e]" />', 'bg-[#'],
    [file, '<div className="border-l-[rgb(1,2,3)]" />', 'border-l-[rgb('],
    [file, "style={{ backgroundColor: '#FFE500', color: 'black' }}", "backgroundColor: '#"],
    [file, "monaco.editor.defineTheme('funny-dark', {", 'defineTheme'],
  ];
  for (const [f, source] of allowed) {
    const v = classify(f, source);
    if (v.length)
      throw new Error(`self-test: expected no violation for ${f}: ${source}\n${v.join('\n')}`);
  }
  for (const [f, source, needle] of forbidden) {
    const v = classify(f, source);
    if (!v.some((m) => m.includes(needle))) {
      throw new Error(`self-test: expected a \`${needle}\` violation for ${f}: ${source}`);
    }
  }
  const [first] = classify(file, 'const a = 1;\n\nconst b = "text-[9px]";');
  if (!first?.startsWith(`${file}:3:`)) throw new Error(`self-test: wrong line in ${first}`);
  console.log('client styling self-test ok');
}

function main(): void {
  if (process.argv.includes('--self-test')) runSelfTest();
  const violations: string[] = [];
  for (const abs of walkSources(join(ROOT, SCANNED), /\.(test|stories)\.tsx?$/)) {
    const file = relative(ROOT, abs).split(sep).join('/');
    violations.push(...classify(file, readFileSync(abs, 'utf8')));
  }
  if (violations.length > 0) {
    console.error(
      `Client styling rules (font size setting, theme, one Monaco theme):\n${violations.join('\n')}`,
    );
    process.exit(1);
  }
  console.log('client styling ok');
}

main();
