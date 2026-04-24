// ─── Auth ────────────────────────────────────────────────

export type UserRole = 'admin' | 'user';

export interface SafeUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  displayName: string;
  role: UserRole;
}

export interface UpdateUserRequest {
  displayName?: string;
  role?: UserRole;
  password?: string;
}

// ─── Teams / Organizations ───────────────────────────────

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: string | null;
  anthropicApiKey?: string | null; // Encrypted at rest
  defaultModel?: string | null;
  defaultMode?: string | null;
  defaultPermissionMode?: string | null;
  createdAt: string;
}

export interface TeamMember {
  id: string;
  userId: string;
  organizationId: string;
  role: TeamRole;
  username?: string;
  displayName?: string;
  email?: string;
  createdAt: string;
}

export interface Invitation {
  id: string;
  email: string;
  organizationId: string;
  role: TeamRole;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  inviterId: string;
  expiresAt: string;
}

export interface TeamProject {
  teamId: string;
  projectId: string;
}

// ─── User Profile (Git Identity) ─────────────────────────

export interface UserProfile {
  id: string;
  userId: string;
  gitName: string | null;
  gitEmail: string | null;
  /** Map of provider key ID → whether a key is set (e.g. { github: true, minimax: false }). */
  providerKeys: Record<string, boolean>;
  /** @deprecated Use providerKeys['github'] */
  hasGithubToken: boolean;
  /** @deprecated Use providerKeys['assemblyai'] */
  hasAssemblyaiKey: boolean;
  /** @deprecated Use providerKeys['minimax'] */
  hasMinimaxApiKey: boolean;
  setupCompleted: boolean;
  defaultEditor: string | null;
  useInternalEditor: boolean | null;
  terminalShell: string | null;
  toolPermissions: Record<string, string> | null;
  theme: string | null;
  runnerInviteToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateProfileRequest {
  gitName?: string;
  gitEmail?: string;
  /** Set or clear a provider key by canonical ID. Value is plaintext; null clears it. */
  providerKey?: { id: string; value: string | null };
  /** @deprecated Use providerKey: { id: 'github', value } */
  githubToken?: string | null;
  /** @deprecated Use providerKey: { id: 'assemblyai', value } */
  assemblyaiApiKey?: string | null;
  /** @deprecated Use providerKey: { id: 'minimax', value } */
  minimaxApiKey?: string | null;
  setupCompleted?: boolean;
  defaultEditor?: string;
  useInternalEditor?: boolean;
  terminalShell?: string;
  toolPermissions?: Record<string, string>;
  theme?: string;
}
