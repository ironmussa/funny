/**
 * @domain subdomain: Shared Kernel
 * @domain type: published-language
 * @domain layer: infrastructure
 */

export type HonoEnv = {
  Variables: {
    userId: string;
    userRole: string;
    traceId: string;
    spanId: string;
  };
};
