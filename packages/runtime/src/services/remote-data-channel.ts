import { createPermitPool } from '@funny/shared/async';
export interface RemoteDataTransport {
  request(eventType: string, payload: Record<string, any>): Promise<any>;
}

const MAX_CONCURRENT_REQUESTS = 20;
const ACQUIRE_TIMEOUT_MS = 20_000;
let transport: RemoteDataTransport | null = null;
const slots = createPermitPool(MAX_CONCURRENT_REQUESTS);

export function configureRemoteDataTransport(next: RemoteDataTransport | null): void {
  transport = next;
}

export async function sendRemoteData(
  eventType: string,
  payload: Record<string, any>,
): Promise<any> {
  const release = await slots.acquire({
    timeoutMs: ACQUIRE_TIMEOUT_MS,
    timeoutError: () => new Error('Data slot acquire timed out'),
  });
  try {
    if (!transport) throw new Error('gRPC runner transport not initialized');
    return await transport.request(eventType, payload);
  } finally {
    release();
  }
}
