import { encodeBrowserCarrier, encodeBrowserStatus } from '@funny/shared/browser-protocol';
import type { Status } from '@funny/shared/browser-v1/common';
import type { CarrierEnvelope } from '@funny/shared/browser-v1/transport';

/**
 * Socket.IO's Bun server parser recognizes Buffer as a binary attachment but
 * serializes a plain Uint8Array as a JSON object. Keep that parser-specific
 * adaptation at the server transport boundary.
 */
export function encodeSocketIoCarrier(envelope: CarrierEnvelope): Buffer {
  return Buffer.from(encodeBrowserCarrier(envelope));
}

export function encodeSocketIoStatus(status: Status): Buffer {
  return Buffer.from(encodeBrowserStatus(status));
}
