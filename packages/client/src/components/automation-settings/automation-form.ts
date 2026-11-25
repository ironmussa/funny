import type { AgentModel, AutomationSchedule, PermissionMode } from '@funny/shared';

export const SCHEDULE_PRESETS: { value: string; label: string }[] = [
  { value: '*/15 * * * *', label: 'Every 15 min' },
  { value: '*/30 * * * *', label: 'Every 30 min' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */2 * * *', label: 'Every 2 hours' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 9 * * *', label: 'Daily at 9am' },
  { value: '0 9 * * 1', label: 'Weekly (Mon 9am)' },
];

/** Find a friendly label for a cron expression, or show the raw expression */
export function getScheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  return preset?.label ?? cron;
}

export interface FormState {
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  model: AgentModel;
  permissionMode: PermissionMode;
}

export const defaultForm: FormState = {
  name: '',
  prompt: '',
  schedule: '0 * * * *',
  model: 'sonnet',
  permissionMode: 'autoEdit',
};
