export type BrowserV1QueueClass = 'operations' | 'events' | 'terminal' | 'browserSession';
export type BrowserV1QueuePriority = 'control' | 'normal' | 'bulk';

interface QueuedMessage {
  byteLength: number;
  coalescingKey?: string;
  droppable: boolean;
  priority: BrowserV1QueuePriority;
  send: () => void | Promise<void>;
}

interface QueueState {
  active: number;
  bytes: number;
  messages: QueuedMessage[];
}

export type BrowserV1QueueResult = 'accepted' | 'coalesced' | 'dropped' | 'exhausted';

export class BrowserV1OutboundQueue {
  private readonly queues = new Map<BrowserV1QueueClass, QueueState>();

  constructor(
    private readonly limits: {
      maxMessagesPerClass: number;
      maxBytesPerClass: number;
      maxConcurrentPerClass: number;
      reservedControlMessages: number;
    },
  ) {
    if (
      limits.maxMessagesPerClass <= 0 ||
      limits.maxBytesPerClass <= 0 ||
      limits.maxConcurrentPerClass <= 0 ||
      limits.reservedControlMessages <= 0
    ) {
      throw new Error('browser outbound queue limits must be positive');
    }
  }

  enqueue(trafficClass: BrowserV1QueueClass, message: QueuedMessage): BrowserV1QueueResult {
    const state = this.state(trafficClass);
    if (message.coalescingKey) {
      const index = state.messages.findIndex(
        (queued) => queued.coalescingKey === message.coalescingKey,
      );
      if (index >= 0) {
        state.bytes += message.byteLength - state.messages[index]!.byteLength;
        state.messages[index] = message;
        if (state.bytes > this.limits.maxBytesPerClass) {
          state.bytes -= message.byteLength;
          state.messages.splice(index, 1);
          return message.droppable ? 'dropped' : 'exhausted';
        }
        this.pump(trafficClass, state);
        return 'coalesced';
      }
    }

    const regularMessages = state.messages.filter((queued) => queued.priority !== 'control').length;
    const controlMessages = state.messages.length - regularMessages;
    const messageLimitReached =
      message.priority === 'control'
        ? controlMessages >= this.limits.reservedControlMessages
        : regularMessages >= this.limits.maxMessagesPerClass;
    if (messageLimitReached || state.bytes + message.byteLength > this.limits.maxBytesPerClass) {
      return message.droppable ? 'dropped' : 'exhausted';
    }

    state.messages.push(message);
    state.bytes += message.byteLength;
    this.pump(trafficClass, state);
    return 'accepted';
  }

  stats(trafficClass: BrowserV1QueueClass): { active: number; messages: number; bytes: number } {
    const state = this.state(trafficClass);
    return { active: state.active, messages: state.messages.length, bytes: state.bytes };
  }

  private state(trafficClass: BrowserV1QueueClass): QueueState {
    let state = this.queues.get(trafficClass);
    if (!state) {
      state = { active: 0, bytes: 0, messages: [] };
      this.queues.set(trafficClass, state);
    }
    return state;
  }

  private pump(trafficClass: BrowserV1QueueClass, state: QueueState): void {
    while (state.active < this.limits.maxConcurrentPerClass && state.messages.length > 0) {
      const controlIndex = state.messages.findIndex((message) => message.priority === 'control');
      const [message] = state.messages.splice(controlIndex >= 0 ? controlIndex : 0, 1);
      if (!message) return;
      state.bytes -= message.byteLength;
      state.active += 1;
      let result: void | Promise<void>;
      try {
        result = message.send();
      } catch {
        state.active -= 1;
        continue;
      }
      if (!result) {
        state.active -= 1;
        continue;
      }
      void result.finally(() => {
        state.active -= 1;
        this.pump(trafficClass, state);
      });
    }
  }
}
