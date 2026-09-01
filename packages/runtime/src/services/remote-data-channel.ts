export interface RemoteDataTransport {
  request(eventType: string, payload: Record<string, any>): Promise<any>;
}

const MAX_CONCURRENT_REQUESTS = 20;
const ACQUIRE_TIMEOUT_MS = 20_000;
let transport: RemoteDataTransport | null = null;
let active = 0;
type QueueEntry = { grant(): void; abort(): void };
const queue: QueueEntry[] = [];

export function configureRemoteDataTransport(next: RemoteDataTransport | null): void {
  transport = next;
}

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_REQUESTS) {
    active++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const entry: QueueEntry = {
      grant: () => {
        clearTimeout(timer);
        active++;
        resolve();
      },
      abort: () => reject(new Error('Data slot acquire timed out')),
    };
    const timer = setTimeout(() => {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
      entry.abort();
    }, ACQUIRE_TIMEOUT_MS);
    queue.push(entry);
  });
}

function release(): void {
  active--;
  queue.shift()?.grant();
}

export async function sendRemoteData(
  eventType: string,
  payload: Record<string, any>,
): Promise<any> {
  await acquire();
  try {
    if (!transport) throw new Error('gRPC runner transport not initialized');
    return await transport.request(eventType, payload);
  } finally {
    release();
  }
}
