import { useState, useRef, useEffect } from 'react';
import { Send, Square, Loader2, Image as ImageIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ImageAttachment } from '@a-parallel/shared';

const MODELS = [
  { value: 'haiku', label: 'Haiku 4.5' },
  { value: 'sonnet', label: 'Sonnet 4.5' },
  { value: 'opus', label: 'Opus 4.6' },
] as const;

const MODES = [
  { value: 'plan', label: 'Plan' },
  { value: 'autoEdit', label: 'Auto Edit' },
  { value: 'confirmEdit', label: 'Ask Before Edits' },
] as const;

interface PromptInputProps {
  onSubmit: (prompt: string, opts: { model: string; mode: string }, images?: ImageAttachment[]) => void;
  onStop?: () => void;
  loading?: boolean;
  running?: boolean;
  placeholder?: string;
}

export function PromptInput({
  onSubmit,
  onStop,
  loading = false,
  running = false,
  placeholder = 'Describe the task...',
}: PromptInputProps) {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>('opus');
  const [mode, setMode] = useState<string>('autoEdit');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!running) textareaRef.current?.focus();
  }, [running]);

  const handleSubmit = () => {
    if ((!prompt.trim() && images.length === 0) || loading || running) return;
    onSubmit(prompt, { model, mode }, images.length > 0 ? images : undefined);
    setPrompt('');
    setImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          await addImageFile(file);
        }
      }
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      await addImageFile(file);
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const addImageFile = async (file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const mediaType = file.type as ImageAttachment['source']['media_type'];

        setImages(prev => [...prev, {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64,
          },
        }]);
        resolve();
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="p-3 border-t border-border flex justify-center">
      <div className="w-1/2 min-w-[320px]">
        {/* Dropdowns row */}
        <div className="flex items-center gap-2 mb-2">
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="w-[100px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, idx) => (
              <div key={idx} className="relative group">
                <img
                  src={`data:${img.source.media_type};base64,${img.source.data}`}
                  alt={`Attachment ${idx + 1}`}
                  className="h-20 w-20 object-cover rounded border border-input"
                />
                <button
                  onClick={() => removeImage(idx)}
                  className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                  disabled={loading || running}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea + action buttons */}
        <div className="flex items-end gap-2">
          <div className="flex-1 flex flex-col gap-2">
            <textarea
              ref={textareaRef}
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none transition-[border-color,box-shadow] duration-150"
              placeholder={running ? 'Agent is working...' : placeholder}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={3}
              disabled={loading || running}
            />
          </div>
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              disabled={loading || running}
            />
            {!running && (
              <Button
                onClick={() => fileInputRef.current?.click()}
                variant="outline"
                size="icon"
                title="Add image"
                disabled={loading || running}
              >
                <ImageIcon className="h-4 w-4" />
              </Button>
            )}
            {running ? (
              <Button
                onClick={onStop}
                variant="destructive"
                size="icon"
                title="Stop agent"
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={(!prompt.trim() && images.length === 0) || loading}
                size="icon"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
