/**
 * "Run a flow" (change flow-triggers): start one run of a flow of the caller's
 * factory now, without an issue, with the input values typed here. The server
 * refuses a flow that needs an issue, a required input left empty, and a
 * factory that cannot work now; its message is shown.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogCancelButton,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { runFactoryFlow } from '@/data/factory/actions';
import { toastError } from '@/lib/toast-error';

import { FactoryFlowFields, typedFlowInputs, useFactoryFlowReady } from './FactoryFlowFields';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The projects whose factory may be started; the first one is preselected. */
  projects: ReadonlyArray<{ id: string; name: string }>;
}

export function RunFactoryFlowDialog({ open, onOpenChange, projects }: Props) {
  const { t } = useTranslation();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [flowName, setFlowName] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false);
  const activeProjectId = projects.some((p) => p.id === projectId)
    ? projectId
    : (projects[0]?.id ?? '');
  const ready = useFactoryFlowReady(activeProjectId, flowName, inputs);

  const start = async () => {
    setStarting(true);
    const started = await runFactoryFlow(activeProjectId, flowName, typedFlowInputs(inputs));
    setStarting(false);
    if (started.isErr()) {
      toastError(started.error, 'factory');
      return;
    }
    toast.success(t('factory.runFlow.started', 'Started the flow "{{flow}}"', { flow: flowName }));
    setInputs({});
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="factory-run-flow-dialog">
        <DialogHeader>
          <DialogTitle>{t('factory.runFlow.title', 'Run a flow')}</DialogTitle>
          <DialogDescription>
            {t(
              'factory.runFlow.description',
              'Starts one run of a flow without an issue, as you, under your factory’s limit. It can open a pull request; it never merges one by itself.',
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {projects.length > 1 && (
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                {t('factory.runFlow.project', 'Project')}
              </span>
              <Select
                value={activeProjectId}
                onValueChange={(value) => {
                  setProjectId(value);
                  setFlowName('');
                  setInputs({});
                }}
              >
                <SelectTrigger data-testid="factory-run-flow-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem
                      key={project.id}
                      value={project.id}
                      data-testid={`factory-run-flow-project-${project.id}`}
                    >
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {activeProjectId && (
            <FactoryFlowFields
              projectId={activeProjectId}
              flowName={flowName}
              onFlowChange={(value) => {
                setFlowName(value);
                setInputs({});
              }}
              inputs={inputs}
              onInputsChange={setInputs}
              testIdPrefix="factory-run-flow"
            />
          )}
        </div>
        <DialogFooter>
          <DialogCancelButton data-testid="factory-run-flow-cancel">
            {t('common.cancel', 'Cancel')}
          </DialogCancelButton>
          <Button
            onClick={() => void start()}
            disabled={!ready || starting}
            data-testid="factory-run-flow-start"
          >
            {t('factory.runFlow.start', 'Run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
