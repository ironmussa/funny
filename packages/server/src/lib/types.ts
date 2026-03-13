/** Hono environment type for context variables set by auth middleware. */
export type ServerEnv = {
  Variables: {
    userId: string;
    userRole: string;
    isRunner: boolean;
    runnerId: string;
    organizationId: string | null;
  };
};
