/**
 * The ACP NDJSON stream over a spawned agent's stdio, shared by every ACP
 * client in this folder. The SDK is loaded lazily by each caller, so its
 * `ndJsonStream` is passed in rather than imported here.
 */
import type { ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';

type NdJsonStream = typeof import('@agentclientprotocol/sdk/unstable').ndJsonStream;

export function childAcpStream(
  child: ChildProcess,
  ndJsonStream: NdJsonStream,
): ReturnType<NdJsonStream> {
  const outputStream: WritableStream<Uint8Array> = Writable.toWeb(child.stdin!);
  // SAFETY: every caller spawns the child with a piped stdout and never sets an
  // encoding, so the web stream yields Buffer chunks, which are Uint8Array instances.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Node.js Readable.toWeb returns ReadableStream<any>
  const inputStream = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  return ndJsonStream(outputStream, inputStream);
}
