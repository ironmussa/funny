import type { MessageDelivery } from '@funny/client-core';

export function assistantMessageUsesRichPresentation(
  richContent: boolean,
  delivery: MessageDelivery | undefined,
): boolean {
  return richContent && delivery !== 'streaming';
}
