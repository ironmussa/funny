import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { usePipelineApprovalStore, type PendingApproval } from '@/stores/pipeline-approval-store';

/**
 * Renders a modal whenever there is at least one pending pipeline approval
 * for the current user. Approvals come in via the `pipeline:approval_requested`
 * WS event and are removed by `pipeline:approval_resolved` once a decision
 * is recorded server-side.
 *
 * Multiple pending approvals are queued: this dialog always shows the
 * oldest one first (FIFO by `requestedAt`). The queue depth is shown in
 * the title so the user can see how many gates are waiting.
 */
export function PipelineApprovalDialog() {
  const pending = usePipelineApprovalStore((s) => s.pending);
  const respond = usePipelineApprovalStore((s) => s.respond);

  const queue = useMemo(() => {
    return Object.values(pending).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }, [pending]);

  const current: PendingApproval | undefined = queue[0];

  if (!current) return null;

  return (
    <ApprovalForm
      key={current.approvalId}
      approval={current}
      respond={respond}
      queueDepth={queue.length}
    />
  );
}

interface ApprovalFormProps {
  approval: PendingApproval;
  respond: (
    approvalId: string,
    decision: 'approve' | 'reject',
    text?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  queueDepth: number;
}

function ApprovalForm({ approval, respond, queueDepth }: ApprovalFormProps) {
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');

  const submitting = approval.submitting === true;
  const submitError = approval.submitError;

  const handleApprove = () => {
    void respond(approval.approvalId, 'approve', approval.captureResponse ? comment : undefined);
  };

  const handleReject = () => {
    if (!reason.trim()) return;
    void respond(approval.approvalId, 'reject', reason);
  };

  return (
    <Dialog open={true}>
      <DialogContent
        // The pipeline is paused on this gate. Allow closing only by
        // explicit approve/reject so users don't lose the dialog.
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        data-testid={`pipeline-approval-${approval.gateId}`}
      >
        <DialogHeader>
          <DialogTitle>
            Pipeline approval
            {queueDepth > 1 ? (
              <span className="text-muted-foreground ml-2 text-sm font-normal">
                (1 of {queueDepth})
              </span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            Gate <code className="bg-muted rounded px-1 py-0.5 text-xs">{approval.gateId}</code> is
            waiting for your decision.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-foreground text-sm whitespace-pre-wrap">{approval.message}</p>

          {approval.captureResponse ? (
            <div className="space-y-2">
              <label
                htmlFor={`approval-comment-${approval.approvalId}`}
                className="text-foreground text-sm font-medium"
              >
                Comment (optional)
              </label>
              <Textarea
                id={`approval-comment-${approval.approvalId}`}
                data-testid="pipeline-approval-comment"
                placeholder="Add a comment for downstream steps..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={submitting}
                rows={3}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <label
              htmlFor={`approval-reason-${approval.approvalId}`}
              className="text-foreground text-sm font-medium"
            >
              Rejection reason (only required if rejecting)
            </label>
            <Textarea
              id={`approval-reason-${approval.approvalId}`}
              data-testid="pipeline-approval-reason"
              placeholder="Why is this being rejected?"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              rows={2}
            />
          </div>

          {submitError ? (
            <p className="text-destructive text-sm" role="alert">
              {submitError}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="destructive"
            onClick={handleReject}
            disabled={submitting || !reason.trim()}
            data-testid="pipeline-approval-reject"
          >
            Reject
          </Button>
          <Button
            onClick={handleApprove}
            disabled={submitting}
            data-testid="pipeline-approval-approve"
          >
            {submitting ? 'Sending…' : 'Approve'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
