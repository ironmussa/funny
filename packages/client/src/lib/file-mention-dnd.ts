const FILE_MENTION_MIME = 'application/x-funny-file-mention';

export type FileMentionPayload = {
  path: string;
  fileType: 'file' | 'folder';
};

export function setFileMentionDragData(
  dataTransfer: DataTransfer,
  payload: FileMentionPayload,
): void {
  const json = JSON.stringify(payload);
  dataTransfer.setData(FILE_MENTION_MIME, json);
  // Fallback for browsers/runtimes that strip custom MIME types during drag.
  dataTransfer.setData('text/plain', payload.path);
  dataTransfer.effectAllowed = 'copy';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function readFileMentionDragData(dataTransfer: DataTransfer): FileMentionPayload | null {
  const raw = dataTransfer.getData(FILE_MENTION_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FileMentionPayload>;
    if (!isString(parsed?.path) || !parsed.path) return null;
    const fileType = parsed.fileType === 'folder' ? 'folder' : 'file';
    return { path: parsed.path, fileType };
  } catch {
    return null;
  }
}

export function dragHasFileMention(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(FILE_MENTION_MIME);
}
