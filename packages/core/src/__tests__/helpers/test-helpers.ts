/**
 * Typed helpers for the core tests: narrow values with runtime checks instead
 * of type assertions, so a wrong shape fails the test instead of hiding behind
 * a cast.
 */
import type { AddressInfo } from 'node:net';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import type { SDKClaudeProcess } from '../../agents/sdk-claude.js';
import type { CLIAssistantMessage, CLIMessage, CLIUserMessage } from '../../agents/types.js';

type CLIMessageType = CLIMessage['type'];

/** Narrows `message` to the CLI message variant `type`, failing the test otherwise. */
export function expectMessageOfType<T extends CLIMessageType>(
  message: CLIMessage | undefined,
  type: T,
): Extract<CLIMessage, { type: T }> {
  if (message === undefined) throw new Error(`expected a '${type}' message, got none`);
  if (!isMessageOfType(message, type)) {
    throw new Error(`expected a '${type}' message, got '${message.type}'`);
  }
  return message;
}

function isMessageOfType<T extends CLIMessageType>(
  message: CLIMessage,
  type: T,
): message is Extract<CLIMessage, { type: T }> {
  return message.type === type;
}

type AssistantBlock = CLIAssistantMessage['message']['content'][number];

type UserBlock = CLIUserMessage['message']['content'][number];

/** The content blocks of every assistant and user message in `messages`, in order. */
export function contentBlocks(messages: readonly CLIMessage[]): Array<AssistantBlock | UserBlock> {
  return messages.flatMap((m): Array<AssistantBlock | UserBlock> =>
    m.type === 'assistant' || m.type === 'user' ? m.message.content : [],
  );
}

/**
 * The first content block of the assistant or user message at `index`, failing
 * the test when there is no such message or it has no content.
 */
export function firstContentBlock(
  messages: readonly CLIMessage[],
  index: number,
): AssistantBlock | UserBlock {
  const message = messages[index];
  if (message?.type !== 'assistant' && message?.type !== 'user') {
    throw new Error(`expected an assistant or user message at ${index}, got '${message?.type}'`);
  }
  const block = message.message.content[0];
  if (block === undefined) throw new Error(`message ${index} has no content`);
  return block;
}

/** The text of the first content block of the message at `index`, failing unless it is text. */
export function firstTextAt(messages: readonly CLIMessage[], index: number): string {
  const block = firstContentBlock(messages, index);
  if (block.type !== 'text') throw new Error(`expected a text block, got '${block.type}'`);
  return block.text;
}

/** Narrows `value` to an instance of `ctor`, failing the test otherwise. */
export function expectInstance<V, T extends V>(
  value: V,
  ctor: abstract new (...args: never[]) => T,
): T {
  if (!(value instanceof ctor)) {
    throw new Error(`expected an instance of ${ctor.name}`);
  }
  return value;
}

/** A request body sent as a string (a JSON payload), failing the test for any other body. */
export function requestBodyText(body: BodyInit | null | undefined): string {
  return z.string().parse(body);
}

/** The URL a `fetch` input names, whatever form it came in. */
function urlOf(input: string | URL | Request): string {
  if (input instanceof URL) return input.href;
  return input instanceof Request ? input.url : input;
}

/** A `fetch` that answers every call with `handler`, given the requested URL as a string. */
export function fakeFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const impl = (input: string | URL | Request, init?: RequestInit) => handler(urlOf(input), init);
  return Object.assign(impl, { preconnect: () => {} });
}

const tcpAddressSchema = z.object({ port: z.number() });

/** The TCP port a listening server is bound to, failing the test for a pipe or a closed server. */
export function listeningPort(server: { address(): AddressInfo | string | null }): number {
  return tcpAddressSchema.parse(server.address()).port;
}

/** The fields of a Claude Agent SDK wire message that a test sets. */
export interface SdkWireFields {
  readonly type: string;
}

/**
 * A Claude Agent SDK wire message built from only the fields a test drives
 * (`type`, `subtype` and the ones the code under test reads).
 */
export function sdkMessage(fields: SdkWireFields): SDKMessage {
  // SAFETY: the SDK message union has many required fields (uuid, usage, ...)
  // that SDKClaudeProcess never reads on the paths these tests drive; the
  // tests assert on what it does with the fields they do set.
  return fields as SDKMessage;
}

const sdkUserMessageSchema = z.object({
  type: z.literal('user'),
  message: z.object({ content: z.array(z.object({ type: z.string(), text: z.string() })) }),
});

/** A message SDKClaudeProcess queues on its input channel. */
type QueuedInput = ReturnType<SDKClaudeProcess['makeUserMessage']>;

/** The text of the first block of a queued SDK user message, failing the test for any other shape. */
export function sdkUserMessageText(value: QueuedInput | void): string {
  const block = sdkUserMessageSchema.parse(value).message.content[0];
  if (block === undefined) throw new Error('the user message has no content');
  return block.text;
}
