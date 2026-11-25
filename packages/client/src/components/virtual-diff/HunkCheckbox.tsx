import { TriCheckbox } from '@/components/ui/tri-checkbox';
import type { VirtualDiffProps } from '@/lib/diff/types';

interface HunkCheckboxProps extends Pick<VirtualDiffProps, 'selectedLines' | 'onHunkToggle'> {
  /** The add/del line indices of the hunk. */
  indices: number[];
  testId: string;
}

/** Tri-state checkbox that toggles every change line of one hunk. */
export function HunkCheckbox({ indices, selectedLines, onHunkToggle, testId }: HunkCheckboxProps) {
  const count = indices.filter((idx) => selectedLines?.has(idx)).length;
  const allChecked = indices.length > 0 && count === indices.length;
  const isPartial = count > 0 && count < indices.length;
  return (
    <span className="flex w-5 shrink-0 items-center justify-center">
      <TriCheckbox
        state={isPartial ? 'indeterminate' : allChecked ? 'checked' : 'unchecked'}
        onToggle={() => {
          if (indices.length > 0) onHunkToggle?.(indices);
        }}
        data-testid={testId}
      />
    </span>
  );
}
