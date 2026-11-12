/**
 * The user's own profile, for both `/api/profile` (REST) and the `profile` tRPC
 * router. Every method acts on the caller only.
 */

import { failure, type ProfilePort } from '@funny/api';
import { err, ok } from 'neverthrow';

import * as ps from '../../services/profile-service.js';

/** The profile of a user who never saved one. */
const defaultProfile = (userId: string) => ({
  userId,
  gitName: null,
  gitEmail: null,
  providerKeys: {},
  hasGithubToken: false,
  hasAssemblyaiKey: false,
  hasMinimaxApiKey: false,
  setupCompleted: false,
  defaultEditor: null,
  useInternalEditor: null,
  terminalShell: null,
  toolPermissions: null,
  theme: null,
  runnerInviteToken: null,
});

export const profilePort: ProfilePort = {
  async get(userId) {
    return ok((await ps.getProfile(userId)) ?? defaultProfile(userId));
  },

  async update(userId, data) {
    return ok(await ps.upsertProfile(userId, data));
  },

  async transcribeToken(userId) {
    const apiKey = await ps.getProviderKey(userId, 'assemblyai');
    if (!apiKey) return err(failure(400, 'AssemblyAI API key not configured'));

    const res = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=600', {
      headers: { Authorization: apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      return err(failure(502, `Token request failed: ${res.status} ${body}`));
    }
    const data = (await res.json()) as { token: string };
    return ok({ token: data.token });
  },

  async setupCompleted(userId) {
    return ok({ setupCompleted: await ps.isSetupCompleted(userId) });
  },

  async runnerInviteToken(userId) {
    return ok({ token: await ps.getOrCreateRunnerInviteToken(userId) });
  },

  async rotateRunnerInviteToken(userId) {
    return ok({ token: await ps.rotateRunnerInviteToken(userId) });
  },
};
