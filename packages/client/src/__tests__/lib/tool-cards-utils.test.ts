import { describe, test, expect } from 'vitest';
import {
  formatInput,
  getTodos,
  getFilePath,
  getQuestions,
  getSummary,
  getToolLabel,
  extToShikiLang,
  getFileExtension,
  getFileName,
} from '@/components/tool-cards/utils';
import { toEditorUri, toEditorUriWithLine } from '@/lib/editor-utils';

const t = (key: string) => key;

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
      { question: 'Which?', header: 'Choice', options: [{ label: 'A', description: 'option a' }], multiSelect: false },
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
    const questions = [
      { question: 'Q1?', header: 'H', options: [], multiSelect: false },
    ];
    expect(getSummary('AskUserQuestion', { questions }, t)).toBe('1 tools.questions');
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
    expect(toEditorUri('C:\\Users\\test\\file.ts', 'vscode')).toBe('vscode://file/C:/Users/test/file.ts');
  });

  test('adds leading slash to relative paths', () => {
    expect(toEditorUri('src/file.ts', 'cursor')).toBe('cursor://file/src/file.ts');
  });
});

describe('toEditorUriWithLine', () => {
  test('appends line number to URI', () => {
    expect(toEditorUriWithLine('/home/user/file.ts:42', 'vscode')).toBe('vscode://file/home/user/file.ts:42');
  });

  test('works without line number', () => {
    expect(toEditorUriWithLine('/home/user/file.ts', 'cursor')).toBe('cursor://file/home/user/file.ts');
  });

  test('returns null for editors without URI scheme', () => {
    expect(toEditorUriWithLine('/home/user/file.ts:42', 'vim')).toBeNull();
  });
});

describe('extToShikiLang', () => {
  test('maps known extensions to languages', () => {
    expect(extToShikiLang('ts')).toBe('typescript');
    expect(extToShikiLang('tsx')).toBe('tsx');
    expect(extToShikiLang('js')).toBe('javascript');
    expect(extToShikiLang('py')).toBe('python');
    expect(extToShikiLang('rs')).toBe('rust');
    expect(extToShikiLang('go')).toBe('go');
    expect(extToShikiLang('css')).toBe('css');
    expect(extToShikiLang('json')).toBe('json');
    expect(extToShikiLang('md')).toBe('markdown');
    expect(extToShikiLang('sh')).toBe('bash');
  });

  test('is case-insensitive', () => {
    expect(extToShikiLang('TS')).toBe('typescript');
    expect(extToShikiLang('PY')).toBe('python');
  });

  test('returns "text" for unknown extensions', () => {
    expect(extToShikiLang('xyz')).toBe('text');
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
