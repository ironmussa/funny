import { useState } from 'react';

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
import { usePendingApprovals } from '@/data/approvals/hooks';
import { respondToApproval, type PendingApproval } from '@/data/approvals/store';

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
  const queue = usePendingApprovals();

  const current: PendingApproval | undefined = queue[0];

  if (!current) return null;

  return <ApprovalForm key={current.approvalId} approval={current} queueDepth={queue.length} />;
}

interface ApprovalFormProps {
  approval: PendingApproval;
  queueDepth: number;
}

function ApprovalForm({ approval, queueDepth }: ApprovalFormProps) {
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');

  // Answering hides the approval at once; a refused answer brings it back with the error.
  const submitError = approval.submitError;

  const handleApprove = () => {
    void respondToApproval(
      approval.approvalId,
      'approve',
      approval.captureResponse ? comment : undefined,
    );
  };

  const handleReject = () => {
    if (!reason.trim()) return;
    void respondToApproval(approval.approvalId, 'reject', reason);
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
            disabled={!reason.trim()}
            data-testid="pipeline-approval-reject"
          >
            Reject
          </Button>
          <Button onClick={handleApprove} data-testid="pipeline-approval-approve">
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
