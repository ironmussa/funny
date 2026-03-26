import { User, FileText, FolderOpen, ImageIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { memo, useMemo, type ReactNode } from 'react';

import type { ReferencedItem } from '@/lib/parse-referenced-files';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';

interface StickyUserMessageProps {
  content: string;
  images?: { source: { media_type: string; data: string } }[];
  onScrollTo: () => void;
}

/** Renders a file/folder reference chip inline (compact version for sticky header) */
function StickyFileChip({ item }: { item: ReferencedItem }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded bg-background/20 px-1.5 py-0.5 align-middle font-sans text-xs text-background/70"
      title={item.path}
    >
      {item.type === 'folder' ? (
        <FolderOpen className="icon-xs shrink-0" />
      ) : (
        <FileText className="icon-xs shrink-0" />
      )}
      {item.path.split('/').pop()}
    </span>
  );
}

function renderStickyInlineContent(
  text: string,
  fileMap: Map<string, ReferencedItem>,
): ReactNode[] {
  if (fileMap.size === 0) return [text];

  const escapedPaths = Array.from(fileMap.keys())
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`@(${escapedPaths.join('|')})`, 'g');

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const path = match[1];
    const item = fileMap.get(path);
    if (item) {
      parts.push(<StickyFileChip key={`chip-${match.index}`} item={item} />);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export const StickyUserMessage = memo(function StickyUserMessage({
  content,
  images,
  onScrollTo,
}: StickyUserMessageProps) {
  const { inlineContent, fileMap } = useMemo(() => parseReferencedFiles(content), [content]);
  const inlineNodes = useMemo(
    () => renderStickyInlineContent(inlineContent.trim(), fileMap),
    [inlineContent, fileMap],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="pointer-events-none absolute left-0 right-0 top-0 z-20 px-4"
    >
      <div className="pointer-events-auto mx-auto min-w-[320px] max-w-3xl">
        <button
          onClick={onScrollTo}
          className="flex w-full cursor-pointer items-start gap-2 rounded-b-lg border border-t-0 bg-foreground/95 px-3 py-2 text-left font-['Noto_Sans'] text-background shadow-lg backdrop-blur-sm transition-colors hover:bg-foreground"
        >
          <User className="icon-xs mt-0.5 flex-shrink-0 text-background/60" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-5 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-background">
              {inlineNodes}
            </p>
            {images && images.length > 0 && (
              <div className="mt-1.5 flex gap-1.5">
                {images.map((img, idx) => (
                  <img
                    key={`image-${idx}`}
                    src={`data:${img.source.media_type};base64,${img.source.data}`}
                    alt={`Attachment ${idx + 1}`}
                    className="h-8 w-8 rounded border border-background/20 object-cover"
                  />
                ))}
                {images.length > 3 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-background/60">
                    <ImageIcon className="icon-xs" />+{images.length - 3}
                  </span>
                )}
              </div>
            )}
          </div>
        </button>
      </div>
    </motion.div>
  );
});
