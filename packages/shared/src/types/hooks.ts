// ─── Project Hooks (Husky-backed) ────────────────────────

export type HookType =
  | 'pre-commit'
  | 'commit-msg'
  | 'pre-push'
  | 'post-commit'
  | 'post-merge'
  | 'post-checkout';

export const HOOK_TYPES: HookType[] = [
  'pre-commit',
  'commit-msg',
  'pre-push',
  'post-commit',
  'post-merge',
  'post-checkout',
];

/** A single command within a hook type */
export interface HookCommand {
  label: string;
  command: string;
  enabled?: boolean; // defaults to true
}

/** Flat representation of a hook command for the UI (includes derived fields) */
export interface ProjectHook {
  hookType: HookType;
  index: number; // position within the hookType's commands array
  label: string;
  command: string;
  enabled: boolean;
}
