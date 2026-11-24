import { useEffect, useMemo, useRef, useState } from 'react';

import { CodeViewer } from '@/components/ui/code-viewer';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { api } from '@/lib/api';

export function SourceTab({
  activeFile,
  projectPath,
}: {
  activeFile: string | null;
  projectPath: string | undefined;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedFile = useRef<string | null>(null);

  useEffect(() => {
    if (!activeFile || !projectPath) {
      setCode(null);
      setError(null);
      loadedFile.current = null;
      return;
    }

    const fullPath = `${projectPath}/${activeFile}`;
    if (loadedFile.current === fullPath) return;

    loadedFile.current = fullPath;
    setLoading(true);
    setError(null);

    api.readFile(fullPath).then((result) => {
      if (result.isOk()) {
        setCode(result.value.content);
      } else {
        setError('Failed to load file');
      }
      setLoading(false);
    });
  }, [activeFile, projectPath]);

  const language = useMemo(() => {
    if (!activeFile) return 'typescript';
    const ext = activeFile.split('.').pop() ?? '';
    if (ext === 'ts' || ext === 'tsx') return 'typescript';
    if (ext === 'js' || ext === 'jsx') return 'javascript';
    return 'typescript';
  }, [activeFile]);

  if (!activeFile) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Run a test to view its source
      </div>
    );
  }
  if (loading) {
    return <LoadingState testId="test-detail-source-loading" label="Loading…" />;
  }
  if (error) {
    return (
      <div className="text-destructive flex h-full items-center justify-center text-xs">
        {error}
      </div>
    );
  }
  if (!code) {
    return <EmptyState title="No source available" />;
  }

  return (
    <div className="h-full overflow-auto">
      <div className="text-muted-foreground border-b px-3 py-1 text-xs">{activeFile}</div>
      <CodeViewer code={code} language={language} maxHeight="none" className="h-full" />
    </div>
  );
}
