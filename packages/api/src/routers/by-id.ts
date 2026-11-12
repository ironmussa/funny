import { z } from 'zod';

import { unwrap } from '../failure.js';
import type { ApiPorts, PortResult } from '../ports.js';
import { protectedProcedure } from '../trpc.js';

export const byId = z.object({ id: z.string().min(1) });

/** A mutation on one of the caller's resources by id; the port answers 404 for anyone else's. */
export function idMutation<T>(
  call: (ports: ApiPorts, userId: string, id: string) => PortResult<T>,
) {
  return protectedProcedure
    .input(byId)
    .mutation(async ({ ctx, input }) => unwrap(await call(ctx.ports, ctx.userId, input.id)));
}
