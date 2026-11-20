/**
 * Shape of the protocol golden wire fixtures (`protocol/<name>/<version>/fixtures/golden.json`),
 * parsed instead of asserted so a malformed fixture fails loudly.
 */
import { z } from 'zod';

export const goldenFixturesSchema = z.array(
  z.object({
    name: z.string(),
    messageType: z.string(),
    protoJson: z.json(),
    wireHex: z.string(),
  }),
);
