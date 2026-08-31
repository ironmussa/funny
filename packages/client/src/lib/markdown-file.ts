export const MARKDOWN_FILE_EXTENSIONS = new Set(['md', 'mdx', 'markdown']);

export function isMarkdownFile(filePath: string): boolean {
  const fileName = filePath.split(/[\\/]/).pop() ?? '';
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  return extension !== undefined && MARKDOWN_FILE_EXTENSIONS.has(extension);
}
