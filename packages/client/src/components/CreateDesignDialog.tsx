import { Loader2, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

const log = createClientLogger('create-design-dialog');

type Fidelity = 'wireframe' | 'high';

export interface CreateDesignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName: string;
}

export function CreateDesignDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
}: CreateDesignDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [tab, setTab] = useState<'prototype' | 'slides' | 'template' | 'other'>('prototype');
  const [prototypeName, setPrototypeName] = useState('');
  const [fidelity, setFidelity] = useState<Fidelity>('high');
  const [slidesName, setSlidesName] = useState('');
  const [speakerNotes, setSpeakerNotes] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetAndClose = () => {
    setPrototypeName('');
    setSlidesName('');
    setSpeakerNotes(false);
    setFidelity('high');
    setError(null);
    onOpenChange(false);
  };

  const submit = async (payload: Parameters<typeof api.createDesign>[1]): Promise<void> => {
    setSubmitting(true);
    setError(null);

    const created = await api.createDesign(projectId, payload);
    if (created.isErr()) {
      log.error('createDesign failed', { projectId, type: payload.type, error: created.error });
      setError(created.error.friendlyMessage ?? created.error.message ?? 'Failed to create design');
      setSubmitting(false);
      return;
    }

    const design = created.value;
    log.info('design created', { designId: design.id, projectId, type: design.type });

    // Best-effort: ask the runner to create the folder. DB row stays even if this fails.
    const dir = await api.createDesignDirectory(projectId, design.id);
    if (dir.isErr()) {
      log.warn('createDesignDirectory failed (db row kept)', {
        designId: design.id,
        error: dir.error,
      });
    }

    toast.success(
      t('createDesign.toast.created', {
        name: design.name,
        defaultValue: `Design "${design.name}" created`,
      }),
    );

    setSubmitting(false);
    resetAndClose();
    navigate(buildPath(`/projects/${projectId}/designs/${design.id}`));
  };

  const handleCreatePrototype = () =>
    submit({
      name: prototypeName.trim(),
      type: 'prototype',
      fidelity,
    });

  const handleCreateSlides = () =>
    submit({
      name: slidesName.trim(),
      type: 'slides',
      speakerNotes,
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && submitting) return;
        if (!v) resetAndClose();
        else onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md p-0" data-testid="create-design-dialog">
        <DialogHeader className="px-6 pt-5 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="icon-base" />
            {t('createDesign.title', { name: projectName, defaultValue: 'Create design' })}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="px-6">
          <TabsList className="bg-sidebar-accent/50 h-7 p-0.5">
            <TabsTrigger
              value="prototype"
              data-testid="create-design-tab-prototype"
              className="data-[state=active]:bg-background h-6 px-2.5 data-[state=active]:shadow-xs"
            >
              {t('createDesign.tabs.prototype', 'Prototype')}
            </TabsTrigger>
            <TabsTrigger
              value="slides"
              data-testid="create-design-tab-slides"
              className="data-[state=active]:bg-background h-6 px-2.5 data-[state=active]:shadow-xs"
            >
              {t('createDesign.tabs.slides', 'Slide deck')}
            </TabsTrigger>
            <TabsTrigger
              value="template"
              data-testid="create-design-tab-template"
              className="data-[state=active]:bg-background h-6 px-2.5 data-[state=active]:shadow-xs"
            >
              {t('createDesign.tabs.template', 'From template')}
            </TabsTrigger>
            <TabsTrigger
              value="other"
              data-testid="create-design-tab-other"
              className="data-[state=active]:bg-background h-6 px-2.5 data-[state=active]:shadow-xs"
            >
              {t('createDesign.tabs.other', 'Other')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="prototype" className="mt-4 min-h-[360px] space-y-4">
            <h3 className="text-sm font-semibold">
              {t('createDesign.prototype.heading', 'New prototype')}
            </h3>

            <Input
              data-testid="create-design-prototype-name"
              placeholder={t('createDesign.projectName', 'Project name')}
              value={prototypeName}
              onChange={(e) => setPrototypeName(e.target.value)}
            />

            <div className="grid grid-cols-2 gap-3">
              <FidelityCard
                testId="create-design-fidelity-wireframe"
                selected={fidelity === 'wireframe'}
                onClick={() => setFidelity('wireframe')}
                label={t('createDesign.prototype.wireframe', 'Wireframe')}
                preview={<WireframePreview />}
              />
              <FidelityCard
                testId="create-design-fidelity-high"
                selected={fidelity === 'high'}
                onClick={() => setFidelity('high')}
                label={t('createDesign.prototype.highFidelity', 'High fidelity')}
                preview={<HighFidelityPreview />}
              />
            </div>

            <Button
              data-testid="create-design-prototype-submit"
              className="w-full"
              onClick={handleCreatePrototype}
              disabled={!prototypeName.trim() || submitting}
            >
              {submitting ? (
                <Loader2 className="icon-sm animate-spin" />
              ) : (
                <Plus className="icon-sm" />
              )}
              {t('createDesign.create', 'Create')}
            </Button>
          </TabsContent>

          <TabsContent value="slides" className="mt-4 min-h-[360px] space-y-4">
            <h3 className="text-sm font-semibold">
              {t('createDesign.slides.heading', 'New slide deck')}
            </h3>

            <Input
              data-testid="create-design-slides-name"
              placeholder={t('createDesign.projectName', 'Project name')}
              value={slidesName}
              onChange={(e) => setSlidesName(e.target.value)}
            />

            <label
              htmlFor="create-design-speaker-notes"
              className="border-border flex cursor-pointer items-center justify-between rounded-md border p-3"
            >
              <span className="flex flex-col">
                <span className="text-sm font-medium">
                  {t('createDesign.slides.speakerNotes', 'Use speaker notes')}
                </span>
                <span className="text-muted-foreground text-xs">
                  {t('createDesign.slides.speakerNotesHint', 'Less text on slides')}
                </span>
              </span>
              <Switch
                id="create-design-speaker-notes"
                data-testid="create-design-speaker-notes"
                checked={speakerNotes}
                onCheckedChange={setSpeakerNotes}
              />
            </label>

            <Button
              data-testid="create-design-slides-submit"
              className="w-full"
              onClick={handleCreateSlides}
              disabled={!slidesName.trim() || submitting}
            >
              {submitting ? (
                <Loader2 className="icon-sm animate-spin" />
              ) : (
                <Plus className="icon-sm" />
              )}
              {t('createDesign.create', 'Create')}
            </Button>
          </TabsContent>

          <TabsContent value="template" className="mt-4 min-h-[360px]">
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t('createDesign.template.empty', 'Templates coming soon.')}
            </p>
          </TabsContent>

          <TabsContent value="other" className="mt-4 min-h-[360px]">
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t('createDesign.other.empty', 'More design types coming soon.')}
            </p>
          </TabsContent>
        </Tabs>

        {error && (
          <p
            data-testid="create-design-error"
            className="border-status-error/40 bg-status-error/10 text-status-error mx-6 mt-2 rounded border px-3 py-2 text-xs"
          >
            {error}
          </p>
        )}

        <p className="text-muted-foreground px-6 pt-3 pb-5 text-center text-xs">
          {t('createDesign.privacy', 'Only you can see your project by default.')}
        </p>
      </DialogContent>
    </Dialog>
  );
}

interface FidelityCardProps {
  testId: string;
  selected: boolean;
  onClick: () => void;
  label: string;
  preview: React.ReactNode;
}

function FidelityCard({ testId, selected, onClick, label, preview }: FidelityCardProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border p-3 transition-colors',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-accent/50',
      )}
    >
      <div className="border-border bg-muted/40 aspect-4/3 w-full overflow-hidden rounded-md border">
        {preview}
      </div>
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function WireframePreview() {
  return (
    <svg viewBox="0 0 100 75" className="text-muted-foreground/50 h-full w-full" fill="none">
      <rect x="10" y="10" width="35" height="22" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="55" y="10" width="35" height="22" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="40" width="80" height="3" rx="1" fill="currentColor" />
      <rect x="10" y="48" width="60" height="3" rx="1" fill="currentColor" />
      <circle cx="22" cy="62" r="6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function HighFidelityPreview() {
  return (
    <svg viewBox="0 0 100 75" className="h-full w-full" fill="none">
      <rect x="6" y="6" width="50" height="6" rx="1.5" className="fill-primary/30" />
      <rect x="60" y="6" width="34" height="6" rx="1.5" className="fill-primary/60" />
      <rect x="6" y="18" width="60" height="3" rx="1" className="fill-muted-foreground/40" />
      <rect x="6" y="25" width="48" height="3" rx="1" className="fill-muted-foreground/40" />
      <rect x="6" y="32" width="55" height="3" rx="1" className="fill-muted-foreground/40" />
      <rect x="6" y="46" width="30" height="8" rx="2" className="fill-primary/60" />
      <rect x="70" y="42" width="22" height="22" rx="2" className="fill-primary/20" />
      <path
        d="M75 56 L82 48 L88 54 L92 50"
        stroke="currentColor"
        strokeWidth="1"
        className="text-primary"
      />
    </svg>
  );
}
