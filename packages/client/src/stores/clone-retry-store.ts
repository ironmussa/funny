import { create } from 'zustand';

/**
 * A clone the user asked to retry from the activity panel: the add-project view
 * opens on its GitHub tab with these values in the clone form. Nothing starts
 * until the user confirms (track-background-activities).
 */
interface CloneRetryValues {
  cloneUrl: string;
  destinationPath: string;
  name?: string;
}

interface CloneRetryState {
  pending: CloneRetryValues | null;
  request: (values: CloneRetryValues) => void;
  /** Takes the pending values once (the view that shows them). */
  take: () => CloneRetryValues | null;
}

export const useCloneRetryStore = create<CloneRetryState>((set, get) => ({
  pending: null,
  request: (values) => set({ pending: values }),
  take: () => {
    const { pending } = get();
    if (pending) set({ pending: null });
    return pending;
  },
}));
