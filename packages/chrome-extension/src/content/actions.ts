import type { Annotation } from './types';

/**
 * Functions a module calls on a module that depends on it. The entry point
 * (`content.ts`) registers them once, so the modules do not import each other in a cycle.
 */
export interface ContentActions {
  copyScreenshotToClipboard: () => Promise<void>;
  deactivate: () => void;
  hideHistoryPanel: () => void;
  hidePopover: () => void;
  hideSettingsPanel: () => void;
  positionPopoverAtPoint: (x: number, y: number) => void;
  sendToFunny: () => Promise<void>;
  showPopoverForEdit: (ann: Annotation, index: number, clickX: number, clickY: number) => void;
  toggleBrowseMode: () => void;
  updateToolbarCount: () => void;
  updateToolbarProjectName: (name: string) => void;
}

let registered: ContentActions | null = null;

export function registerContentActions(fns: ContentActions): void {
  registered = fns;
}

export function actions(): ContentActions {
  if (!registered) throw new Error('[Funny Annotator] content actions used before registration');
  return registered;
}
