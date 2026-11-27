/**
 * The state of the "Send to the issue factory" dialog: the flow, the lane and
 * the branches chosen for one send, what the selection waits on, and the send.
 */
import type { FactoryLane } from '@funny/shared/contracts/factory';
import type { DomainError } from '@funny/shared/errors';
import type { TFunction } from 'i18next';
import { okAsync, type ResultAsync } from 'neverthrow';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { sendIssuesToFactory } from '@/data/factory/actions';
import { useFactoryBlockers, useFactoryFlows, useFactoryLanes } from '@/data/factory/hooks';
import { useDataQuery } from '@/data/hooks';
import { projectBranchesQuery } from '@/data/projects/branches';
import { api } from '@/lib/api';
import type { FactorySettings } from '@/lib/api/factory';
import { toastError } from '@/lib/toast-error';

import {
  KEEP_LANE,
  activeLanesOf,
  blockersOutside,
  issuesInOtherLane,
  reportSend,
  sendBlockedReason,
  sendLaneChoice,
  type SendLaneChoice,
} from './issue-factory-send';
import { sendRouteOf, type RouteChoice } from './IssueFactorySendRoute';

/** The lane of a send, with the controls that choose it. */
export interface SendLane extends SendLaneChoice {
  /** The lane select's value. */
  choice: string;
  setChoice: (choice: string) => void;
  /** The text typed as a new lane's name. */
  newLane: string;
  setNewLane: (text: string) => void;
  activeLanes: FactoryLane[];
  /** The selected issues that already carry another lane's label. */
  otherLane: Array<{ issue: number; label: string }>;
}

function useSendLane(
  projectId: string,
  settings: FactorySettings,
  selected: number[],
  labelsOf: (issueNumber: number) => string[],
): SendLane {
  const lanes = useFactoryLanes(projectId);
  const [choice, setChoice] = useState(KEEP_LANE);
  const [newLane, setNewLane] = useState('');
  const activeLanes = activeLanesOf(lanes);
  const lane = sendLaneChoice(activeLanes, choice, newLane, settings.laneLabelPrefix);
  const otherLane = lane.label
    ? issuesInOtherLane(selected, labelsOf, settings.laneLabelPrefix, lane.label)
    : [];
  return { ...lane, choice, setChoice, newLane, setNewLane, activeLanes, otherLane };
}

// The lane is a label on the issue (openspec factory-lanes D1), read when the
// factory admits it: the label goes on first, and an issue GitHub did not
// label is not sent, so it cannot run outside the lane it was meant for.
function labelForLane(
  t: TFunction,
  projectId: string,
  selected: number[],
  laneLabel: string | null,
): ResultAsync<number[], DomainError> {
  if (laneLabel === null) return okAsync(selected);
  return api.githubAddIssueLabels(projectId, selected, [laneLabel]).map((result) => {
    if (result.failed.length > 0) {
      toast.warning(
        t('factory.laneLabelFailed', 'Not sent, the lane label could not be added: {{issues}}', {
          issues: result.failed.map((f) => f.message).join(' '),
        }),
      );
    }
    return result.labeled;
  });
}

export interface FactorySendInput {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  settings: FactorySettings;
  /** The selected issues that can be sent. */
  selected: number[];
  /** The GitHub labels an issue of the list carries now. */
  labelsOf: (issueNumber: number) => string[];
  /** The issues the factory accepted (they leave the selection). */
  onSent: (accepted: number[]) => void;
}

interface SendChoices {
  flow: string;
  lane: SendLane;
  route: RouteChoice;
  defaultBranch: string | undefined;
}

function useSendAction(input: FactorySendInput, choices: SendChoices) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const { projectId, settings, selected, onOpenChange, onSent } = input;
  const { flow, lane, route, defaultBranch } = choices;
  // A lane that exists keeps its branches: the send names none for it.
  const sendRoute = () =>
    lane.existing ? undefined : sendRouteOf(route, settings, lane.name, defaultBranch);

  const send = () => {
    setSending(true);
    void labelForLane(t, projectId, selected, lane.label)
      .andThen((issues) => sendIssuesToFactory(projectId, issues, flow, sendRoute()))
      .match(
        (result) => {
          setSending(false);
          reportSend(t, result);
          if (result.accepted.length > 0) onOpenChange(false);
          onSent(result.accepted);
        },
        (error) => {
          setSending(false);
          toastError(error, 'factory');
        },
      );
  };
  return { sending, send };
}

/** What the selection waits on, and why the send is off. */
export function useSendNotices(projectId: string, settings: FactorySettings, selected: number[]) {
  const { t } = useTranslation();
  const blockers = useFactoryBlockers(projectId, selected);
  return {
    /** Why the send button is off, or null. */
    blocked: sendBlockedReason(t, settings),
    /** The blockers that are neither in the factory nor in the selection. */
    outside: blockersOutside(blockers, selected),
  };
}

export type SendNotices = ReturnType<typeof useSendNotices>;

/** The choices of one send and the send itself. */
export function useFactorySendForm(input: FactorySendInput) {
  const { projectId, settings, selected, labelsOf } = input;
  const flows = useFactoryFlows(projectId);
  const lane = useSendLane(projectId, settings, selected, labelsOf);
  const [flow, setFlow] = useState(settings.flowName);
  // The branches for this send alone; they start as the factory's settings.
  const [route, setRoute] = useState<RouteChoice>({
    base: settings.baseBranch,
    finish: settings.laneFinishBranch,
  });
  const { data: branchData } = useDataQuery(projectBranchesQuery(projectId));
  const defaultBranch = branchData?.defaultBranch ?? undefined;
  const { sending, send } = useSendAction(input, { flow, lane, route, defaultBranch });
  return {
    flow,
    setFlow,
    flowOptions: flows ?? [{ name: settings.flowName, source: 'built-in' as const }],
    lane,
    route,
    setRoute,
    defaultBranch,
    sending,
    send,
  };
}

export type FactorySendForm = ReturnType<typeof useFactorySendForm>;
