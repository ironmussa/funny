import type { AgentModel } from '@funny/shared';
import { Play } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';

import { SegmentedControl } from '@/components/settings/SegmentedControl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import { SCHEDULE_PRESETS, type FormState } from './automation-form';

const MODEL_OPTIONS: { value: AgentModel; label: string }[] = [
  { value: 'haiku', label: 'Haiku' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
];

interface AutomationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isEditing: boolean;
  form: FormState;
  setForm: Dispatch<SetStateAction<FormState>>;
  onSave: (andTest: boolean) => void;
}

function ScheduleField({ form, setForm }: Pick<AutomationFormDialogProps, 'form' | 'setForm'>) {
  return (
    <fieldset>
      <legend className="settings-label">Schedule</legend>
      <Select
        value={
          SCHEDULE_PRESETS.some((p) => p.value === form.schedule) ? form.schedule : '__custom__'
        }
        onValueChange={(v) => {
          if (v !== '__custom__') setForm((f) => ({ ...f, schedule: v }));
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCHEDULE_PRESETS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
          <SelectItem value="__custom__">Custom cron…</SelectItem>
        </SelectContent>
      </Select>
      {!SCHEDULE_PRESETS.some((p) => p.value === form.schedule) && (
        <Input
          mono
          size="xs"
          className="settings-form-input mt-1.5"
          placeholder="*/30 * * * *"
          value={form.schedule}
          onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))}
        />
      )}
      <p className="text-muted-foreground mt-1 text-xs">Cron: min hour day month weekday</p>
    </fieldset>
  );
}

export function AutomationFormDialog({
  open,
  onOpenChange,
  isEditing,
  form,
  setForm,
  onSave,
}: AutomationFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Automation' : 'Create Automation'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="automation-name" className="settings-label">
              Name
            </label>
            <Input
              id="automation-name"
              className="settings-form-input"
              placeholder="e.g. Daily Issue Triage"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="automation-prompt" className="settings-label">
              Prompt
            </label>
            <Textarea
              id="automation-prompt"
              className="min-h-[100px] resize-y text-sm"
              placeholder="What should the agent do?"
              value={form.prompt}
              onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ScheduleField form={form} setForm={setForm} />
            <fieldset>
              <legend className="settings-label">Model</legend>
              <SegmentedControl
                options={MODEL_OPTIONS}
                value={form.model}
                onChange={(v) => setForm((f) => ({ ...f, model: v }))}
              />
            </fieldset>
          </div>
          <p className="text-muted-foreground text-xs">
            Automations run locally in read-only mode (no file writes).
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSave(true)}
            disabled={!form.name.trim() || !form.prompt.trim()}
            className="gap-1.5"
          >
            <Play className="icon-xs" />
            {isEditing ? 'Save & Test' : 'Create & Test'}
          </Button>
          <Button
            size="sm"
            onClick={() => onSave(false)}
            disabled={!form.name.trim() || !form.prompt.trim()}
          >
            {isEditing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
