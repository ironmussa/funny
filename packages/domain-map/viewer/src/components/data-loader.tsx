import { Upload } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { useDomainStore } from '@/stores/domain-store';
import type { SerializedGraph } from '@/types/domain';

export function DataLoader() {
  const setGraph = useDomainStore((s) => s.setGraph);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      try {
        const text = await file.text();
        const json = JSON.parse(text) as SerializedGraph;
        if (!json.nodes || !json.subdomains) {
          throw new Error('Invalid domain graph JSON: missing nodes or subdomains');
        }
        setGraph(json);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to parse JSON');
      }
    },
    [setGraph],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file);
    },
    [loadFile],
  );

  return (
    <div className="flex h-full items-center justify-center">
      <div
        data-testid="data-loader-dropzone"
        className={`flex flex-col items-center gap-4 rounded-lg border-2 border-dashed p-12 transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25'
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-10 w-10 text-muted-foreground" />
        <div className="text-center">
          <p className="text-lg font-medium">Load domain graph</p>
          <p className="text-sm text-muted-foreground">
            Drag & drop a JSON file or click to browse
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Generate with:{' '}
            <code className="rounded bg-muted px-1.5 py-0.5">
              bun domain-map --format json --domain-file domain.yaml src/
            </code>
          </p>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <input
          ref={inputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
          }}
        />
      </div>
    </div>
  );
}
