import { EmptyState } from './empty-state';
import { LoadingState } from './loading-state';

export function SearchEmptyRow({ text }: { text: string }) {
  return <EmptyState fill={false} className="px-3 py-6" title={text} />;
}

export function SearchLoadingRow({ text, testId }: { text: string; testId: string }) {
  return (
    <LoadingState fill={false} layout="inline" className="px-3 py-6" testId={testId} label={text} />
  );
}
