export function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

export function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash) {
    return filePath.substring(lastDot + 1);
  }
  return '';
}

export function getMonacoLanguage(ext: string, filePath?: string): string {
  if (filePath) {
    const name = getFileName(filePath);
    if (/^\.env(\..+)?$/.test(name) || name === '.env') return 'dotenv';
  }
  const langMap = new Map(
    Object.entries({
      env: 'dotenv',
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
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
      mdx: 'markdown',
      markdown: 'markdown',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      toml: 'toml',
      xml: 'xml',
      html: 'html',
      htm: 'html',
      css: 'css',
      scss: 'scss',
      less: 'less',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell',
      ps1: 'powershell',
      dockerfile: 'dockerfile',
      php: 'php',
      vue: 'vue',
      graphql: 'graphql',
    }),
  );
  return langMap.get(ext.toLowerCase()) || 'plaintext';
}
