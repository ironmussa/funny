/**
 * The tRPC thread procedures authorize through the same decision as the REST
 * `requireThread*` middlewares (`threadAccessPolicy` in routes/threads.ts).
 */

import type { ThreadAccessPort } from '@funny/api';

import { threadAccessPolicy } from '../../routes/threads.js';

export const threadAccessPort: ThreadAccessPort = threadAccessPolicy;
