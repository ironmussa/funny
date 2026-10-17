import type { QueuedMessage } from '@funny/shared';
import type { TFunction } from 'i18next';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

interface UseQueueEditingParams {
  t: TFunction;
  onQueueEditSave?: (messageId: string, content: string) => void;
  onQueueDelete?: (messageId: string) => void;
}

/** Inline edit / delete state for the queued-messages list. */
export function useQueueEditing({ t, onQueueEditSave, onQueueDelete }: UseQueueEditingParams) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const startEdit = useCallback((message: QueuedMessage) => {
    setEditingId(message.id);
    setEditingContent(message.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingContent('');
  }, []);

  const saveEdit = useCallback(
    (messageId: string) => {
      const nextContent = editingContent.trim();
      if (!nextContent) {
        toast.warning(t('prompt.emptyPrompt', 'Please enter a prompt before sending'));
        return;
      }
      setBusyId(messageId);
      onQueueEditSave?.(messageId, editingContent);
      setEditingId(null);
      setEditingContent('');
      setBusyId((current) => (current === messageId ? null : current));
    },
    [editingContent, onQueueEditSave, t],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      setBusyId(messageId);
      onQueueDelete?.(messageId);
      if (editingId === messageId) {
        setEditingId(null);
        setEditingContent('');
      }
      setBusyId((current) => (current === messageId ? null : current));
    },
    [editingId, onQueueDelete],
  );

  return {
    editingId,
    editingContent,
    setEditingContent,
    busyId,
    startEdit,
    cancelEdit,
    saveEdit,
    deleteMessage,
  };
}

export type QueueEditing = ReturnType<typeof useQueueEditing>;
