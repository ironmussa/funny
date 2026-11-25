/**
 * The flows the caller's factory can run, each with its YAML: the repository's
 * `.funny/workflows/<name>.yaml` from the default branch, or the built-in of
 * that name. Read-only: a repository flow is changed by committing it.
 */
import { FileCode } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CodeViewer } from '@/components/ui/code-viewer';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LoadingState } from '@/components/ui/loading-state';
import { useFactoryFlowDefinition, useFactoryFlows } from '@/data/factory/hooks';

function FlowYamlDialog({
  projectId,
  flowName,
  onClose,
}: {
  projectId: string;
  flowName: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { definition, error } = useFactoryFlowDefinition(projectId, flowName);

  const builtIn = t('settings.projectFactoryFlowBuiltIn', 'Built-in flow, shipped with funny');
  const loading = t('settings.projectFactoryFlowLoading', 'Reading the flow…');
  const description = error
    ? t('settings.projectFactoryFlowUnreadable', 'Could not read this flow')
    : definition
      ? (definition.path ?? builtIn)
      : loading;

  return (
    <Dialog open={!!flowName} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col"
        data-testid="factory-flow-dialog"
      >
        <DialogHeader>
          <DialogTitle>{flowName}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="border-border/50 min-h-0 flex-1 overflow-hidden rounded-md border">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : definition ? (
            <CodeViewer code={definition.yaml} language="yaml" maxHeight="70vh" padded />
          ) : (
            <LoadingState label={loading} className="min-h-[20vh]" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectFactoryFlows({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const flows = useFactoryFlows(projectId);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section data-testid="settings-factory-flows">
      <h3 className="text-muted-foreground px-1 pb-1 text-xs font-semibold tracking-wider uppercase">
        {t('settings.projectFactoryFlows', 'Flows')}
      </h3>
      <p className="text-muted-foreground px-1 pb-2 text-xs">
        {t(
          'settings.projectFactoryFlowsDesc',
          'What a run executes. A .funny/workflows/<name>.yaml on the default branch replaces the built-in of the same name.',
        )}
      </p>
      <div className="border-border/50 mb-6 divide-y overflow-hidden rounded-lg border">
        {flows === undefined ? (
          <LoadingState label={t('settings.projectFactoryFlowsLoading', 'Reading flows…')} />
        ) : (
          flows.map((flow) => (
            <div
              key={flow.name}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
              data-testid={`settings-factory-flow-${flow.name}`}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-foreground truncate font-mono text-sm">{flow.name}</span>
                <Badge variant="secondary">
                  {flow.source === 'repository'
                    ? t('settings.projectFactoryFlowRepository', 'Repository')
                    : t('settings.projectFactoryFlowBuiltInBadge', 'Built-in')}
                </Badge>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpen(flow.name)}
                data-testid={`settings-factory-flow-view-${flow.name}`}
              >
                <FileCode className="icon-sm" />
                {t('settings.projectFactoryViewYaml', 'View YAML')}
              </Button>
            </div>
          ))
        )}
      </div>
      <FlowYamlDialog projectId={projectId} flowName={open} onClose={() => setOpen(null)} />
    </section>
  );
}
