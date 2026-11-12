import type { UpdateProfileRequest } from '@funny/shared';

import { trpc, trpcCall } from './_trpc';

const procedures = trpc.profile;

export const profileApi = {
  getProfile: () => trpcCall(() => procedures.get.query()),
  updateProfile: (data: UpdateProfileRequest) => trpcCall(() => procedures.update.mutate(data)),
  getTranscribeToken: () => trpcCall(() => procedures.transcribeToken.query()),
  isSetupCompleted: () => trpcCall(() => procedures.setupCompleted.query()),
  getRunnerInviteToken: () => trpcCall(() => procedures.runnerInviteToken.query()),
  rotateRunnerInviteToken: () => trpcCall(() => procedures.rotateRunnerInviteToken.mutate()),
  completeSetup: () => trpcCall(() => procedures.update.mutate({ setupCompleted: true })),
};
