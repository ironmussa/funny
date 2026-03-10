/**
 * @domain subdomain: Shared Kernel
 * @domain type: published-language
 * @domain layer: infrastructure
 */

export type HonoEnv = {
  Variables: {
    userId: string;
    userRole: string;
    organizationId: string | null;
    traceId: string;
    spanId: string;
  };
};
