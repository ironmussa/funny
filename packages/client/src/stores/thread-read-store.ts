import {
  createThreadReadStore,
  isThreadUnread,
  type ThreadReadState,
} from '@funny/client-core/stores/thread-read';

import { bindVanillaStore } from '@/platform/bind-vanilla-store';
import { clientComposition } from '@/platform/client-composition';

const threadReadStore = createThreadReadStore({
  storage: clientComposition.platform.storage,
  diagnostics: clientComposition.platform.diagnostics,
});

export const useThreadReadStore = bindVanillaStore<ThreadReadState>(threadReadStore);
export { isThreadUnread };
