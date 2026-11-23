/**
 * The flow and its input values of a start without an issue (change
 * flow-triggers): the flow select, one field per input the flow declares and
 * the factory does not supply, and why the flow cannot run without an issue.
 * Shared by the "Run a flow" dialog and the schedule trigger form.
 */
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFactoryFlows, useFactoryIssuelessFlow } from '@/data/factory/hooks';

interface Props {
  projectId: string;
  flowName: string;
  onFlowChange: (flowName: string) => void;
  inputs: Record<string, string>;
  onInputsChange: (inputs: Record<string, string>) => void;
  /** Prefix of the fields' `data-testid`s. */
  testIdPrefix: string;
}

/** Whether the chosen flow can start now: it runs without an issue and no required input is empty. */
export function useFactoryFlowReady(
  projectId: string,
  flowName: string,
  inputs: Record<string, string>,
): boolean {
  const { flow } = useFactoryIssuelessFlow(projectId, flowName);
  if (!flow || flow.problems.length > 0) return false;
  return flow.inputs.every((input) => !input.required || (inputs[input.name] ?? '').trim() !== '');
}

export function FactoryFlowFields({
  projectId,
  flowName,
  onFlowChange,
  inputs,
  onInputsChange,
  testIdPrefix,
}: Props) {
  const { t } = useTranslation();
  const flows = useFactoryFlows(projectId);
  const { flow, error } = useFactoryIssuelessFlow(projectId, flowName);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t('factory.flowFields.flow', 'Flow')}</span>
        <Select value={flowName} onValueChange={onFlowChange}>
          <SelectTrigger data-testid={`${testIdPrefix}-flow`}>
            <SelectValue placeholder={t('factory.flowFields.chooseFlow', 'Choose a flow')} />
          </SelectTrigger>
          <SelectContent>
            {(flows ?? []).map((option) => (
              <SelectItem
                key={option.name}
                value={option.name}
                data-testid={`${testIdPrefix}-flow-${option.name}`}
              >
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {error && (
        <Alert variant="destructive" data-testid={`${testIdPrefix}-error`}>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {flow && flow.problems.length > 0 && (
        <Alert variant="destructive" data-testid={`${testIdPrefix}-problems`}>
          <AlertDescription>
            <p>
              {t(
                'factory.flowFields.needsIssue',
                'This flow cannot run without an issue. Send an issue to it from the Issues tab instead.',
              )}
            </p>
            <ul className="mt-1 list-disc pl-4">
              {flow.problems.map((problem) => (
                <li key={`${problem.step}-${problem.field}`}>
                  <span className="font-mono">{problem.step}</span>: {problem.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {flow?.problems.length === 0 &&
        flow.inputs.map((input) => (
          <label key={input.name} className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              <span className="font-mono">{input.name}</span>
              {input.required && ` · ${t('factory.flowFields.required', 'required')}`}
              {input.description && ` · ${input.description}`}
            </span>
            <Input
              value={inputs[input.name] ?? ''}
              onChange={(e) => onInputsChange({ ...inputs, [input.name]: e.target.value })}
              data-testid={`${testIdPrefix}-input-${input.name}`}
            />
          </label>
        ))}
    </div>
  );
}

/** The values of the inputs the flow declares, without the empty ones. */
export function typedFlowInputs(inputs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => value.trim() !== ''));
}
