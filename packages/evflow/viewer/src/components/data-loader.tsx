import { Loader2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import type { EventModelData } from '../../../src/types';
import { useViewerStore } from '../stores/viewer-store';

function parseModelJSON(raw: any): EventModelData {
  return {
    name: raw.name,
    elements: new Map(Object.entries(raw.elements)),
    sequences: raw.sequences ?? [],
    slices: raw.slices ?? [],
    contexts: raw.contexts ?? [],
  };
}

/**
 * Accepts .json or .ts evflow model files.
 * - .json files are parsed directly
 * - .ts files are sent to the dev server's /api/convert endpoint
 *   which runs them through bun to extract the JSON
 */
export function DataLoader() {
  const setModel = useViewerStore((s) => s.setModel);
  const hasModel = useViewerStore((s) => !!s.model);
  const inputRef = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);

  const loadJSON = useCallback(
    (text: string) => {
      const raw = JSON.parse(text);
      setModel(parseModelJSON(raw));
    },
    [setModel],
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (file.name.endsWith('.json')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            loadJSON(e.target?.result as string);
          } catch (err) {
            alert(`Failed to parse JSON: ${err instanceof Error ? err.message : err}`);
          }
        };
        reader.readAsText(file);
      } else if (file.name.endsWith('.ts')) {
        setConverting(true);
        try {
          const text = await file.text();
          const res = await fetch('/api/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: text,
          });

          if (!res.ok) {
            const body = await res.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(body.error || `Server returned ${res.status}`);
          }

          const json = await res.text();
          loadJSON(json);
        } catch (err) {
          alert(
            `Failed to convert .ts file:\n\n${err instanceof Error ? err.message : err}\n\n` +
              `Make sure the file exports a function that returns an EventModel ` +
              `(e.g. export function createRuntimeModel())`,
          );
        } finally {
          setConverting(false);
        }
      } else {
        alert('Please load a .json or .ts file');
      }
    },
    [loadJSON],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  if (hasModel) {
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() => inputRef.current?.click()}
        data-testid="viewer-load-another"
      >
        Load another
        <input
          ref={inputRef}
          type="file"
          accept=".json,.ts"
          onChange={handleChange}
          className="hidden"
        />
      </Button>
    );
  }

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="flex h-full flex-col items-center justify-center gap-4"
    >
      <div className="space-y-2 text-center">
        <h1 className="text-foreground text-2xl font-bold">evflow Viewer</h1>
        <p className="text-muted-foreground text-sm">
          Drop an evflow model file here (.json or .ts)
        </p>
        <p className="text-muted-foreground/70 text-xs">
          Supports <code className="bg-muted rounded px-1.5 py-0.5">.json</code> from{' '}
          <code className="bg-muted rounded px-1.5 py-0.5">model.toJSON()</code> or{' '}
          <code className="bg-muted rounded px-1.5 py-0.5">.ts</code> source files directly
        </p>
      </div>

      {converting ? (
        <div className="flex items-center gap-2 text-sm text-blue-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Converting .ts model...
        </div>
      ) : (
        <label>
          <Button asChild data-testid="viewer-choose-file">
            <span>Choose file</span>
          </Button>
          <input type="file" accept=".json,.ts" onChange={handleChange} className="hidden" />
        </label>
      )}

      <div
        className="border-border text-muted-foreground hover:border-muted-foreground/50 flex h-40 w-80 items-center justify-center rounded-xl border-2 border-dashed text-sm transition-colors"
        data-testid="viewer-drop-zone"
      >
        Drop .json or .ts file here
      </div>
    </div>
  );
}
