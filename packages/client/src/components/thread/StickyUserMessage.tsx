import { User, FileText, ImageIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { memo, useMemo } from 'react';

import { parseReferencedFiles } from '@/lib/parse-referenced-files';

interface StickyUserMessageProps {
  content: string;
  images?: { source: { media_type: string; data: string } }[];
  onScrollTo: () => void;
}

export const StickyUserMessage = memo(function StickyUserMessage({
  content,
  images,
  onScrollTo,
}: StickyUserMessageProps) {
  const { files, cleanContent } = useMemo(() => parseReferencedFiles(content), [content]);

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
          className="flex w-full cursor-pointer items-start gap-2 rounded-b-lg border border-t-0 bg-foreground/95 px-3 py-2 text-left text-background shadow-lg backdrop-blur-sm transition-colors hover:bg-foreground"
        >
          <User className="mt-0.5 h-3 w-3 flex-shrink-0 text-background/60" />
          <div className="min-w-0 flex-1">
            {files.length > 0 && (
              <div className="mb-1 flex flex-wrap gap-1">
                {files.map((file) => (
                  <span
                    key={file}
                    className="inline-flex items-center gap-1 rounded bg-background/20 px-1.5 py-0.5 font-mono text-xs text-background/70"
                    title={file}
                  >
                    <FileText className="h-3 w-3 shrink-0" />
                    {file.split('/').pop()}
                  </span>
                ))}
              </div>
            )}
            <pre className="line-clamp-5 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-background">
              {cleanContent.trim()}
            </pre>
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
                    <ImageIcon className="h-3 w-3" />+{images.length - 3}
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
