import { trpc, trpcCall } from './_trpc';

/** Background activities (track-background-activities): the caller's own, over tRPC. */
export const activitiesApi = {
  listActivities: () => trpcCall(() => trpc.activities.list.query()),
  dismissActivity: (id: string) => trpcCall(() => trpc.activities.dismiss.mutate({ id })),
  clearFinishedActivities: () => trpcCall(() => trpc.activities.clearFinished.mutate()),
};
