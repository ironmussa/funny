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
    organizationName: string | null;
    traceId: string;
    spanId: string;
    /**
     * Steer-share delegation claim (thread-sharing-steer). Set from the SIGNED
     * forwarded identity when the server delegated a `steer` sharee's request to
     * the owner's runner. `shareLevel === 'steer'` + `onBehalfOfThread === <id>`
     * authorizes the sharee for the allow-listed routes on that thread only.
     * `null` for every ordinary (owner) request.
     */
    shareLevel: string | null;
    onBehalfOfThread: string | null;
  };
};
