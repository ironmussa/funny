import { trpc, trpcCall } from './_trpc';

export const watchersApi = {
  listWatchers: () => trpcCall(() => trpc.watchers.list.query()),
  cancelWatcher: (id: string) => trpcCall(() => trpc.watchers.cancel.mutate({ id })),
};
