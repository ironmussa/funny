import { lazy, useMemo } from 'react';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';

export const ReactDiffViewer = lazy(() => import('react-diff-viewer-continued'));

export const DIFF_VIEWER_STYLES = {
  variables: {
    light: {
      diffViewerBackground: 'hsl(var(--background))',
      diffViewerColor: 'hsl(var(--foreground))',
      addedBackground: 'hsl(142 76% 36% / 0.15)',
      addedColor: 'hsl(142 76% 76%)',
      removedBackground: 'hsl(0 84% 60% / 0.15)',
      removedColor: 'hsl(0 84% 80%)',
      wordAddedBackground: 'hsl(142 76% 36% / 0.3)',
      wordRemovedBackground: 'hsl(0 84% 60% / 0.3)',
      addedGutterBackground: 'hsl(142 76% 36% / 0.1)',
      removedGutterBackground: 'hsl(0 84% 60% / 0.1)',
      gutterBackground: 'hsl(var(--muted))',
      gutterBackgroundDark: 'hsl(var(--muted))',
      highlightBackground: 'hsl(var(--accent))',
      highlightGutterBackground: 'hsl(var(--accent))',
    },
    dark: {
      diffViewerBackground: 'hsl(var(--background))',
      diffViewerColor: 'hsl(var(--foreground))',
      addedBackground: 'hsl(142 76% 36% / 0.15)',
      addedColor: 'hsl(142 76% 76%)',
      removedBackground: 'hsl(0 84% 60% / 0.15)',
      removedColor: 'hsl(0 84% 80%)',
      wordAddedBackground: 'hsl(142 76% 36% / 0.3)',
      wordRemovedBackground: 'hsl(0 84% 60% / 0.3)',
      addedGutterBackground: 'hsl(142 76% 36% / 0.1)',
      removedGutterBackground: 'hsl(0 84% 60% / 0.1)',
      gutterBackground: 'hsl(var(--muted))',
      gutterBackgroundDark: 'hsl(var(--muted))',
      highlightBackground: 'hsl(var(--accent))',
      highlightGutterBackground: 'hsl(var(--accent))',
    },
  },
  line: {
    fontSize: 'inherit',
    lineHeight: '1.4',
    fontFamily: "'Geist Mono', ui-monospace, monospace",
  },
  contentText: {
    whiteSpace: 'pre',
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    // wordBreak: 'break-all',
    // overflow: 'hidden',
  },
  diffContainer: {
    width: '100%',
    maxWidth: '100%',
    // overflow: 'hidden', // Removed to allow scrolling
    // tableLayout: 'auto', // Removed to fix type error and allow natural layout
  },
  gutter: {
    whiteSpace: 'nowrap',
    width: '1%',
    minWidth: '40px',
  },
};

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export function formatInput(input: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return { value: input };
    }
  }
  return input;
}

export function getTodos(parsed: Record<string, unknown>): TodoItem[] | null {
  const todos = parsed.todos;
  if (!Array.isArray(todos)) return null;
  return todos as TodoItem[];
}

export function getFilePath(name: string, parsed: Record<string, unknown>): string | null {
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    return parsed.file_path as string ?? null;
  }
  return null;
}

export function getQuestions(parsed: Record<string, unknown>): Question[] | null {
  const questions = parsed.questions;
  if (!Array.isArray(questions)) return null;
  return questions as Question[];
}

export function getSummary(name: string, parsed: Record<string, unknown>, t: (key: string) => string): string | null {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return parsed.file_path as string ?? null;
    case 'Bash':
      return parsed.command as string ?? null;
    case 'Glob':
      return parsed.pattern as string ?? null;
    case 'Grep':
      return parsed.pattern as string ?? null;
    case 'Task':
      return parsed.description as string ?? null;
    case 'WebSearch':
      return parsed.query as string ?? null;
    case 'WebFetch':
      return parsed.url as string ?? null;
    case 'NotebookEdit':
      return parsed.notebook_path as string ?? null;
    case 'TodoWrite': {
      const todos = getTodos(parsed);
      if (!todos) return null;
      const done = todos.filter((t) => t.status === 'completed').length;
      return `${done}/${todos.length} ${t('tools.done')}`;
    }
    case 'AskUserQuestion': {
      const questions = getQuestions(parsed);
      if (!questions) return null;
      return `${questions.length} ${questions.length > 1 ? t('tools.questionsPlural') : t('tools.questions')}`;
    }
    default:
      return null;
  }
}

export function getToolLabel(name: string, t: (key: string) => string): string {
  const labels: Record<string, string> = {
    Read: t('tools.readFile'),
    Write: t('tools.writeFile'),
    Edit: t('tools.editFile'),
    Bash: t('tools.runCommand'),
    Glob: t('tools.findFiles'),
    Grep: t('tools.searchCode'),
    WebFetch: t('tools.fetchUrl'),
    WebSearch: t('tools.webSearch'),
    Task: t('tools.subagent'),
    TodoWrite: t('tools.todos'),
    NotebookEdit: t('tools.editNotebook'),
    AskUserQuestion: t('tools.question'),
  };
  return labels[name] ?? name;
}

// Re-export editor utilities from the central module
export { toEditorUri, toEditorUriWithLine, hasEditorUri, openFileInEditor, openFileInInternalEditor, getEditorLabel } from '@/lib/editor-utils';

const EXT_TO_SHIKI_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  md: 'markdown',
  mdx: 'mdx',
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  lua: 'lua',
  php: 'php',
  vue: 'vue',
  svelte: 'svelte',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'proto',
  ini: 'ini',
  env: 'dotenv',
  tf: 'hcl',
  zig: 'zig',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  dart: 'dart',
  r: 'r',
  scala: 'scala',
  clj: 'clojure',
};

export function extToShikiLang(ext: string): string {
  return EXT_TO_SHIKI_LANG[ext.toLowerCase()] ?? 'text';
}

export function getFileExtension(filePath: string): string {
  const parts = filePath.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.split('/').pop() || filePath;
}

/**
 * Hook that returns the current thread's project path (for stripping from absolute file paths).
 */
export function useCurrentProjectPath(): string | undefined {
  const projectId = useThreadStore(s => s.activeThread?.projectId);
  const worktreePath = useThreadStore(s => s.activeThread?.worktreePath);
  const projects = useProjectStore(s => s.projects);
  return useMemo(
    () => worktreePath || projects.find(p => p.id === projectId)?.path,
    [projects, projectId, worktreePath]
  );
}

/**
 * Strips the project root prefix from an absolute file path to display a shorter relative path.
 * Falls back to the original path if the project path is not a prefix.
 */
export function makeRelativePath(filePath: string, projectPath: string | undefined): string {
  if (!projectPath) return filePath;
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedProject = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedFile.startsWith(normalizedProject + '/')) {
    return normalizedFile.slice(normalizedProject.length + 1);
  }
  return filePath;
}
