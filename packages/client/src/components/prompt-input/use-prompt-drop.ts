import { useCallback, useRef, useState } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { dragHasFileMention, readFileMentionDragData } from '@/lib/file-mention-dnd';

interface UsePromptDropParams {
  editorRef: React.RefObject<PromptEditorHandle | null>;
  loading: boolean;
  addFiles: (files: FileList) => Promise<void>;
  addImageFile: (file: File) => Promise<void>;
  onEditorPaste?: (e: ClipboardEvent) => void;
}

/** Drag & drop, file picker and clipboard-image handling for the prompt box. */
export function usePromptDrop({
  editorRef,
  loading,
  addFiles,
  addImageFile,
  onEditorPaste,
}: UsePromptDropParams) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files') || dragHasFileMention(e.dataTransfer)) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (loading) return;

    const mention = readFileMentionDragData(e.dataTransfer);
    if (mention) {
      editorRef.current?.insertFileMention(mention.path, mention.fileType);
      editorRef.current?.focus();
      return;
    }

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    await addFiles(files);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    await addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleEditorPaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) addImageFile(file);
      }
      onEditorPaste?.(e);
    },
    [addImageFile, onEditorPaste],
  );

  const endDrag = useCallback(() => setIsDragging(false), []);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), [fileInputRef]);

  return {
    fileInputRef,
    isDragging,
    endDrag,
    openFilePicker,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleFileSelect,
    handleEditorPaste,
  };
}
