import { CheckCircle2, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';

function continueToApp() {
  window.location.href = '/';
}

interface InviteOutcomeProps {
  kind: 'success' | 'already' | 'error';
  orgName: string;
  errorMessage: string;
}

/** The final card of the invite flow: joined, already a member, or failed. */
export function InviteOutcome({ kind, orgName, errorMessage }: InviteOutcomeProps) {
  if (kind === 'success') {
    return (
      <>
        <CheckCircle2 className="text-status-success mx-auto size-8" />
        <h2 className="text-foreground text-lg font-semibold">You're in!</h2>
        <p className="text-muted-foreground text-sm">
          You've successfully joined <span className="font-medium">{orgName}</span>.
        </p>
        <Button onClick={continueToApp} className="w-full" data-testid="invite-continue">
          Continue to App
        </Button>
      </>
    );
  }
  if (kind === 'already') {
    return (
      <>
        <CheckCircle2 className="text-status-info mx-auto size-8" />
        <h2 className="text-foreground text-lg font-semibold">Already a member</h2>
        <p className="text-muted-foreground text-sm">
          You're already a member of <span className="font-medium">{orgName}</span>.
        </p>
        <Button onClick={continueToApp} className="w-full" data-testid="invite-continue">
          Continue to App
        </Button>
      </>
    );
  }
  return (
    <>
      <XCircle className="text-destructive mx-auto size-8" />
      <h2 className="text-foreground text-lg font-semibold">Invitation failed</h2>
      <p className="text-muted-foreground text-sm">{errorMessage}</p>
      <Button
        variant="outline"
        onClick={continueToApp}
        className="w-full"
        data-testid="invite-continue"
      >
        Go to App
      </Button>
    </>
  );
}
