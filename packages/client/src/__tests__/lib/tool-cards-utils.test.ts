import { describe, test, expect } from 'vitest';

import {
  formatInput,
  getTodos,
  getFilePath,
  getQuestions,
  getSummary,
  getToolLabel,
  getFileExtension,
  getFileName,
  isTodoToolName,
  isPathWithin,
  unwrapShellCommand,
} from '@/components/tool-cards/format-utils';
import { getMcpSummary, isBrowserTool } from '@/components/tool-cards/mcp-tool';
import { extToHljsLang } from '@/hooks/use-highlight';
import { toEditorUri, toEditorUriWithLine } from '@/lib/editor-utils';

const t = (key: string) => key;

describe('friendly labels for agent and MCP tools', () => {
  test('MCP tool names become "Server · Action" titles, also for groups', () => {
    expect(getToolLabel('mcp__linear__save_issue', t)).toBe('Linear · Save issue');
    expect(getToolLabel('mcp__funny__funny_spawn', t)).toBe('funny · tools.mcp.backgroundJob');
    expect(getToolLabel('mcp__chrome-devtools__take_snapshot', t)).toBe(
      'Chrome DevTools · Take snapshot',
    );
  });

  test('the chrome-devtools calls from the thread get readable titles', () => {
    expect(getToolLabel('mcp__chrome-devtools__list_pages', t)).toBe(
      'Chrome DevTools · List pages',
    );
    expect(getToolLabel('mcp__chrome-devtools__navigate_page', t)).toBe(
      'Chrome DevTools · Navigate page',
    );
  });

  test('a command wrapped in /bin/bash -lc shows the command itself', () => {
    expect(getSummary('Bash', { command: "/bin/bash -lc 'cat migration-state.json'" }, t)).toBe(
      'cat migration-state.json',
    );
    expect(
      getSummary('Bash', { command: `/bin/bash -lc "python3 - <<'PY'\\nprint(\\"hi\\")"` }, t),
    ).toBe(`python3 - <<'PY'\\nprint("hi")`);
    expect(unwrapShellCommand(`bash -lc 'echo '\\''quoted'\\'''`)).toBe("echo 'quoted'");
    // Not a wrapper: unchanged.
    expect(unwrapShellCommand('bun run lint && bash -lc x')).toBe('bun run lint && bash -lc x');
  });

  test('agent tools get a label and a one-line summary', () => {
    expect(getToolLabel('ToolSearch', t)).toBe('tools.loadTools');
    expect(getSummary('ToolSearch', { query: 'select:TaskCreate,TaskUpdate' }, t)).toBe(
      'TaskCreate, TaskUpdate',
    );
    expect(getSummary('Skill', { skill: 'query-logs' }, t)).toBe('query-logs');
    expect(getSummary('TaskCreate', { subject: 'Ship it' }, t)).toBe('Ship it');
    expect(getSummary('TaskUpdate', { taskId: '14', status: 'completed' }, t)).toBe(
      '#14 → completed',
    );
    expect(getSummary('ScheduleWakeup', { reason: 'Watch CI' }, t)).toBe('Watch CI');
    expect(getSummary('SendMessage', { to: 'a1', summary: 'Resume fixes' }, t)).toBe(
      'Resume fixes',
    );
    expect(
      getSummary(
        'apply_patch',
        { input: '*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n' },
        t,
      ),
    ).toBe('a.ts +1');
    expect(getSummary('ApplyPatch', { changes: [{ path: 'c.ts' }] }, t)).toBe('c.ts');
    expect(getSummary('Tool', { server: 'supabase', tool: 'get_advisors' }, t)).toBe(
      'supabase · get_advisors',
    );
  });
});

describe('browser tool cards', () => {
  const browser = (tool: string) => ({ server: 'funny_browser', tool });

  test('browser tools get translated titles', () => {
    expect(getToolLabel('mcp__funny_browser__browser_act', t)).toBe(
      'Browser · tools.mcp.browserAct',
    );
    expect(getToolLabel('mcp__funny_browser__browser_open', t)).toBe(
      'Browser · tools.mcp.browserOpen',
    );
    expect(isBrowserTool(browser('browser_act'))).toBe(true);
    expect(isBrowserTool({ server: 'playwright', tool: 'browser_click' })).toBe(false);
  });

  test('summaries describe the action, its target and its input', () => {
    expect(getMcpSummary({ action: 'click', ref: 'e7' }, browser('browser_act'))?.text).toBe(
      'click e7',
    );
    expect(
      getMcpSummary({ action: 'fill', ref: 'e3', text: 'me@example.com' }, browser('browser_act'))
        ?.text,
    ).toBe('fill e3 · "me@example.com"');
    expect(getMcpSummary({ action: 'press', key: 'Enter' }, browser('browser_act'))?.text).toBe(
      'press · Enter',
    );
    expect(
      getMcpSummary({ action: 'double_click', x: 10, y: 20 }, browser('browser_act'))?.text,
    ).toBe('double click (10, 20)');
    expect(
      getMcpSummary({ url: 'https://dash.cloudflare.com' }, browser('browser_open'))?.text,
    ).toBe('https://dash.cloudflare.com');
    expect(getMcpSummary({ action: 'back' }, browser('browser_navigate'))?.text).toBe('back');
    expect(getMcpSummary({ width: 800, height: 600 }, browser('browser_resize'))?.text).toBe(
      '800×600',
    );
  });

  test('browser summaries keep every input listed in the card', () => {
    expect(getMcpSummary({ action: 'click', ref: 'e7' }, browser('browser_act'))?.key).toBe('');
  });
});

describe('formatInput', () => {
  test('parses JSON string into object', () => {
    const result = formatInput('{"file_path": "/tmp/test.ts"}');
    expect(result).toEqual({ file_path: '/tmp/test.ts' });
  });

  test('wraps non-JSON string in { value: ... }', () => {
    const result = formatInput('not json');
    expect(result).toEqual({ value: 'not json' });
  });

  test('returns object as-is', () => {
    const obj = { foo: 'bar' };
    const result = formatInput(obj);
    expect(result).toBe(obj);
  });
});

describe('isTodoToolName', () => {
  test('recognizes Claude and Cursor todo tool names', () => {
    expect(isTodoToolName('TodoWrite')).toBe(true);
    expect(isTodoToolName('updateTodos')).toBe(true);
    expect(isTodoToolName('todo_write')).toBe(true);
    expect(isTodoToolName('Grep')).toBe(false);
  });
});

describe('getTodos', () => {
  test('returns array of todos when present', () => {
    const todos = [
      { content: 'Task 1', status: 'pending', activeForm: 'Doing task 1' },
      { content: 'Task 2', status: 'completed', activeForm: 'Doing task 2' },
    ];
    expect(getTodos({ todos })).toEqual(todos);
  });

  test('returns null when todos is not an array', () => {
    expect(getTodos({ todos: 'not array' })).toBeNull();
  });

  test('returns null when todos key is missing', () => {
    expect(getTodos({})).toBeNull();
  });

  test('normalizes Cursor updateTodos metadata-only input when todos arrive later', () => {
    const todos = getTodos({
      todos: [{ id: '1', content: 'Fix CI', status: 'in_progress' }],
    });
    expect(todos).toEqual([{ content: 'Fix CI', status: 'in_progress' }]);
  });

  test('normalizes Codex todo_list items into checklist entries', () => {
    const todos = getTodos({
      todos: [
        { text: 'Inspect the thread card', completed: true },
        { text: 'Render the checklist', completed: false },
      ],
    });

    expect(todos).toEqual([
      { content: 'Inspect the thread card', status: 'completed' },
      { content: 'Render the checklist', status: 'pending' },
    ]);
  });
});

describe('getFilePath', () => {
  test('returns file_path for Read tool', () => {
    expect(getFilePath('Read', { file_path: '/tmp/test.ts' })).toBe('/tmp/test.ts');
  });

  test('returns file_path for Write tool', () => {
    expect(getFilePath('Write', { file_path: '/tmp/test.ts' })).toBe('/tmp/test.ts');
  });

  test('returns file_path for Edit tool', () => {
    expect(getFilePath('Edit', { file_path: '/tmp/test.ts' })).toBe('/tmp/test.ts');
  });

  test('returns null for other tools', () => {
    expect(getFilePath('Bash', { command: 'ls' })).toBeNull();
  });

  test('returns null when file_path is missing', () => {
    expect(getFilePath('Read', {})).toBeNull();
  });
});

describe('getQuestions', () => {
  test('returns questions array when present', () => {
    const questions = [
      {
        question: 'Which?',
        header: 'Choice',
        options: [{ label: 'A', description: 'option a' }],
        multiSelect: false,
      },
    ];
    expect(getQuestions({ questions })).toEqual(questions);
  });

  test('returns null when questions is not an array', () => {
    expect(getQuestions({ questions: 'not array' })).toBeNull();
  });

  test('returns null when questions key is missing', () => {
    expect(getQuestions({})).toBeNull();
  });
});

describe('getSummary', () => {
  test('returns file_path for Read', () => {
    expect(getSummary('Read', { file_path: '/tmp/test.ts' }, t)).toBe('/tmp/test.ts');
  });

  test('returns file_path for Write', () => {
    expect(getSummary('Write', { file_path: '/tmp/test.ts' }, t)).toBe('/tmp/test.ts');
  });

  test('returns file_path for Edit', () => {
    expect(getSummary('Edit', { file_path: '/tmp/test.ts' }, t)).toBe('/tmp/test.ts');
  });

  test('returns command for Bash', () => {
    expect(getSummary('Bash', { command: 'npm test' }, t)).toBe('npm test');
  });

  test('returns pattern for Glob', () => {
    expect(getSummary('Glob', { pattern: '**/*.ts' }, t)).toBe('**/*.ts');
  });

  test('returns pattern for Grep', () => {
    expect(getSummary('Grep', { pattern: 'TODO' }, t)).toBe('TODO');
  });

  test('returns description for Task', () => {
    expect(getSummary('Task', { description: 'research code' }, t)).toBe('research code');
  });

  test('returns query for WebSearch', () => {
    expect(getSummary('WebSearch', { query: 'react hooks' }, t)).toBe('react hooks');
  });

  test('returns url for WebFetch', () => {
    expect(getSummary('WebFetch', { url: 'https://example.com' }, t)).toBe('https://example.com');
  });

  test('returns notebook_path for NotebookEdit', () => {
    expect(getSummary('NotebookEdit', { notebook_path: '/tmp/nb.ipynb' }, t)).toBe('/tmp/nb.ipynb');
  });

  test('returns progress for TodoWrite', () => {
    const todos = [
      { content: 'a', status: 'completed', activeForm: 'a' },
      { content: 'b', status: 'pending', activeForm: 'b' },
    ];
    expect(getSummary('TodoWrite', { todos }, t)).toBe('1/2 tools.done');
  });

  test('returns question count for AskUserQuestion', () => {
    const questions = [{ question: 'Q1?', header: 'H', options: [], multiSelect: false }];
    expect(getSummary('AskUserQuestion', { questions }, t)).toBe('1 tools.questions');
  });

  test('returns label or command for Background', () => {
    expect(getSummary('Background', { label: 'typecheck', command: 'bun run typecheck' }, t)).toBe(
      'typecheck',
    );
    expect(getSummary('Background', { command: 'bun run typecheck' }, t)).toBe('bun run typecheck');
  });

  test('returns plural question count for multiple questions', () => {
    const questions = [
      { question: 'Q1?', header: 'H', options: [], multiSelect: false },
      { question: 'Q2?', header: 'H', options: [], multiSelect: false },
    ];
    expect(getSummary('AskUserQuestion', { questions }, t)).toBe('2 tools.questionsPlural');
  });

  test('returns null for unknown tool', () => {
    expect(getSummary('Unknown', {}, t)).toBeNull();
  });
});

describe('getToolLabel', () => {
  test('returns translated label for known tools', () => {
    expect(getToolLabel('Read', t)).toBe('tools.readFile');
    expect(getToolLabel('Bash', t)).toBe('tools.runCommand');
    expect(getToolLabel('TodoWrite', t)).toBe('tools.todos');
    expect(getToolLabel('Background', t)).toBe('tools.background');
  });

  test('returns tool name for unknown tools', () => {
    expect(getToolLabel('CustomTool', t)).toBe('CustomTool');
  });
});

describe('toEditorUri', () => {
  test('creates URI for vscode', () => {
    expect(toEditorUri('/home/user/file.ts', 'vscode')).toBe('vscode://file/home/user/file.ts');
  });

  test('creates URI for cursor', () => {
    expect(toEditorUri('/home/user/file.ts', 'cursor')).toBe('cursor://file/home/user/file.ts');
  });

  test('creates URI for windsurf', () => {
    expect(toEditorUri('/home/user/file.ts', 'windsurf')).toBe('windsurf://file/home/user/file.ts');
  });

  test('creates URI for zed', () => {
    expect(toEditorUri('/home/user/file.ts', 'zed')).toBe('zed://file/home/user/file.ts');
  });

  test('returns null for sublime (no URI scheme)', () => {
    expect(toEditorUri('/home/user/file.ts', 'sublime')).toBeNull();
  });

  test('returns null for vim (no URI scheme)', () => {
    expect(toEditorUri('/home/user/file.ts', 'vim')).toBeNull();
  });

  test('normalizes Windows backslashes', () => {
    expect(toEditorUri('C:\\Users\\test\\file.ts', 'vscode')).toBe(
      'vscode://file/C:/Users/test/file.ts',
    );
  });

  test('adds leading slash to relative paths', () => {
    expect(toEditorUri('src/file.ts', 'cursor')).toBe('cursor://file/src/file.ts');
  });
});

describe('toEditorUriWithLine', () => {
  test('appends line number to URI', () => {
    expect(toEditorUriWithLine('/home/user/file.ts:42', 'vscode')).toBe(
      'vscode://file/home/user/file.ts:42',
    );
  });

  test('works without line number', () => {
    expect(toEditorUriWithLine('/home/user/file.ts', 'cursor')).toBe(
      'cursor://file/home/user/file.ts',
    );
  });

  test('returns null for editors without URI scheme', () => {
    expect(toEditorUriWithLine('/home/user/file.ts:42', 'vim')).toBeNull();
  });
});

describe('extToHljsLang', () => {
  test('maps known extensions to languages', () => {
    expect(extToHljsLang('ts')).toBe('typescript');
    expect(extToHljsLang('tsx')).toBe('typescript');
    expect(extToHljsLang('js')).toBe('javascript');
    expect(extToHljsLang('py')).toBe('python');
    expect(extToHljsLang('rs')).toBe('rust');
    expect(extToHljsLang('go')).toBe('go');
    expect(extToHljsLang('css')).toBe('css');
    expect(extToHljsLang('json')).toBe('json');
    expect(extToHljsLang('md')).toBe('markdown');
    expect(extToHljsLang('sh')).toBe('bash');
  });

  test('is case-insensitive', () => {
    expect(extToHljsLang('TS')).toBe('typescript');
    expect(extToHljsLang('PY')).toBe('python');
  });

  test('returns "plaintext" for unknown extensions', () => {
    expect(extToHljsLang('xyz')).toBe('plaintext');
  });
});

describe('getFileExtension', () => {
  test('returns extension from filename', () => {
    expect(getFileExtension('file.ts')).toBe('ts');
    expect(getFileExtension('path/to/file.tsx')).toBe('tsx');
  });

  test('returns last extension for dotted filenames', () => {
    expect(getFileExtension('file.test.ts')).toBe('ts');
  });

  test('returns empty string for extensionless files', () => {
    expect(getFileExtension('Makefile')).toBe('');
  });
});

describe('getFileName', () => {
  test('returns filename from Unix path', () => {
    expect(getFileName('/home/user/file.ts')).toBe('file.ts');
  });

  test('returns filename from Windows path', () => {
    expect(getFileName('C:\\Users\\test\\file.ts')).toBe('file.ts');
  });

  test('returns the input if no separator', () => {
    expect(getFileName('file.ts')).toBe('file.ts');
  });
});

describe('isPathWithin', () => {
  test('accepts the base itself and its descendants', () => {
    expect(isPathWithin('/repo', '/repo')).toBe(true);
    expect(isPathWithin('/repo/src/a.ts', '/repo')).toBe(true);
    expect(isPathWithin('/repo/src/a.ts', '/repo/')).toBe(true);
  });

  test('rejects paths outside the base', () => {
    expect(isPathWithin('/tmp/script.sh', '/repo')).toBe(false);
    expect(isPathWithin('/home/u/.claude/projects/x/memory/a.md', '/repo')).toBe(false);
  });

  test('rejects sibling-prefix paths', () => {
    expect(isPathWithin('/repo-other/a.ts', '/repo')).toBe(false);
  });

  test('normalizes Windows separators', () => {
    expect(isPathWithin('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe(true);
  });

  test('rejects an empty base', () => {
    expect(isPathWithin('/repo/a.ts', '')).toBe(false);
  });
});
