import { createContext, use } from 'react';

export type CollapsibleContextValue = {
  contentId: string;
  disabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

export function useCollapsibleContext(component: string) {
  const context = use(CollapsibleContext);
  if (!context) {
    throw new Error(`${component} must be used within Collapsible.`);
  }
  return context;
}
