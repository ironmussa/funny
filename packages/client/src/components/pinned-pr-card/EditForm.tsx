import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/** Inline form that edits a comment's body. */
export function EditForm({
  initial,
  onCancel,
  onSave,
  saving,
  testId,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (body: string) => void;
  saving: boolean;
  testId: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        aria-label="Comment body"
        className="border-border bg-background focus:ring-ring w-full rounded-md border p-2 text-xs focus:ring-1 focus:outline-hidden"
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        data-testid={`${testId}-textarea`}
      />
      <div className="flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onCancel} data-testid={`${testId}-cancel`}>
          Cancel
        </Button>
        <Button
          size="xs"
          onClick={() => onSave(value)}
          disabled={saving || value.trim() === initial.trim() || !value.trim()}
          data-testid={`${testId}-save`}
        >
          {saving ? <Loader2 className="icon-xs animate-spin" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}
