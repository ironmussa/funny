import { UserRound } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { AgentAccountRow } from '@/data/agent-account/store';
import {
  currentUtilization,
  formatResetsIn,
  planLabel,
  usageWindowLabel,
} from '@/lib/agent-account-format';
import { shortTimeAgo } from '@/lib/thread-utils';

interface Props {
  /** Last account the thread's runs reported; absent until a run reports one. */
  account?: AgentAccountRow;
  /** The thread's recorded execution profile name, shown before any report. */
  profileName?: string | null;
}

/** Bar tone per window: red from 90 %, amber from 70 %. */
function usageTone(pct: number): 'default' | 'warning' | 'error' {
  if (pct >= 90) return 'error';
  if (pct >= 70) return 'warning';
  return 'default';
}

function updatedLabel(capturedAt: number, now: number): string {
  const ago = shortTimeAgo(capturedAt, now);
  return ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`;
}

type UsageWindow = NonNullable<AgentAccountRow['usage']>['windows'][number];
type ExtraUsage = NonNullable<NonNullable<AgentAccountRow['usage']>['extraUsage']>;
type AccountInfo = AgentAccountRow['account'];

/** The execution profile name, and the plan badge when the plan is known. */
function AccountHeader({ name, plan }: { name: string; plan: string | null | undefined }) {
  return (
    <div className="flex items-center gap-2">
      <UserRound className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 truncate font-medium" data-testid="agent-account-profile">
        {name}
      </span>
      {plan && (
        <span className="ml-auto shrink-0">
          <Badge variant="secondary" size="xs" data-testid="agent-account-plan">
            {plan}
          </Badge>
        </span>
      )}
    </div>
  );
}

/** One plan usage window: its label, percentage, bar and reset time. */
function UsageWindowRow({ window: w, now }: { window: UsageWindow; now: number }) {
  const pct = currentUtilization(w, now);
  const resets = formatResetsIn(w.resetsAt, now);
  return (
    <div data-testid={`agent-account-window-${w.key}`}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate">{usageWindowLabel(w)}</span>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {pct === null ? '—' : `${Math.round(pct)}%`}
        </span>
      </div>
      <div className="mt-1">
        <Progress
          value={pct ?? 0}
          size="thin"
          tone={usageTone(pct ?? 0)}
          data-testid={`agent-account-bar-${w.key}`}
        />
      </div>
      {resets && <p className="text-muted-foreground mt-0.5 text-xs">{resets}</p>}
    </div>
  );
}

/** Extra usage credits spent, when the account reports any. */
function ExtraUsageLine({ extra }: { extra: ExtraUsage | undefined }) {
  if (!extra || extra.usedCredits === null) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="agent-account-extra">
      Extra usage: {extra.usedCredits}
      {extra.monthlyLimit !== null && ` / ${extra.monthlyLimit}`}
      {extra.currency ? ` ${extra.currency}` : ''}
    </p>
  );
}

/** Whether the account runs on a third-party API provider, where plan limits do not apply. */
function thirdPartyProvider(info: AccountInfo | undefined): string | null {
  const provider = info?.apiProvider;
  return provider && provider !== 'firstParty' ? provider : null;
}

/**
 * The account a thread runs on — funny execution profile, Claude login and
 * plan — and the account's total plan usage. Top of the context usage card.
 */
export function AgentAccountSummary({ account, profileName }: Props) {
  const name = account?.profileName ?? profileName ?? 'Default profile';
  const info = account?.account;
  const plan = planLabel(info?.subscriptionType);
  const identity = [info?.email, info?.organization].filter(Boolean).join(' · ');
  // The card mounts when it opens: the time it opened is what it shows.
  const [now] = useState(() => Date.now());
  const windows = account?.usage?.windows ?? [];

  const provider = account && windows.length === 0 ? thirdPartyProvider(info) : null;

  return (
    <div data-testid="agent-account-summary" className="border-border mb-3 border-b pb-3">
      <AccountHeader name={name} plan={plan} />
      {identity && (
        <p
          className="text-muted-foreground mt-0.5 truncate pl-6 text-xs"
          data-testid="agent-account-identity"
        >
          {identity}
        </p>
      )}

      {windows.length > 0 && (
        <div className="mt-2 space-y-2" data-testid="agent-account-usage">
          {windows.map((w) => (
            <UsageWindowRow key={w.key} window={w} now={now} />
          ))}
          <ExtraUsageLine extra={account?.usage?.extraUsage} />
          <p className="text-muted-foreground text-xs">
            {updatedLabel(account?.capturedAt ?? now, now)}
          </p>
        </div>
      )}
      {provider && (
        <p className="text-muted-foreground mt-1 pl-6 text-xs">
          Plan limits do not apply ({provider}).
        </p>
      )}
    </div>
  );
}
