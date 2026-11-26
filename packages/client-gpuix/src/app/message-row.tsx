/** One transcript message: text, tool calls and diffs. */

import type { ThreadWorkspaceData } from '@funny/client-core';
import { AssistantMessage, ConversationRow, UserMessageCard } from '@funny/gpuix-ui/conversation';
import { StatusCard, ToolCallCard } from '@funny/gpuix-ui/status-card';
import type { ToolCall } from '@funny/shared';
import { memo, type ReactElement, useCallback, useState } from 'react';

import {
  createMessageContentPreview,
  MESSAGE_CONTENT_COLLAPSED_CHARACTERS,
  MESSAGE_CONTENT_COLLAPSED_LINES,
  nextMessageContentPreviewLength,
} from '../message-content-preview';
import { assistantMessageUsesRichPresentation } from '../message-render-mode';
import {
  createToolOutputPreview,
  nextToolOutputPreviewLength,
  TOOL_OUTPUT_COLLAPSED_CHARACTERS,
  TOOL_OUTPUT_COLLAPSED_LINES,
} from '../tool-output-preview';
import { NativeButton, useNativeColors } from './hooks';

function extractDiff(content: string): string | null {
  const match = /```diff\s*\n([\s\S]*?)```/.exec(content);
  return match?.[1]?.trim() || null;
}

export const ToolCallBlock = memo(function ToolCallBlock({
  richContent,
  toolCall,
}: {
  richContent: boolean;
  toolCall: ToolCall;
}) {
  const colors = useNativeColors();
  const content = toolCall.output ?? toolCall.input;
  const [requestedCharacters, setRequestedCharacters] = useState(TOOL_OUTPUT_COLLAPSED_CHARACTERS);
  const preview = createToolOutputPreview(content, requestedCharacters);
  const collapsed = requestedCharacters <= TOOL_OUTPUT_COLLAPSED_CHARACTERS;
  return (
    <ConversationRow>
      <ToolCallCard
        title={toolCall.name}
        status={toolCall.output ? 'completed' : 'running'}
        tone="neutral"
      >
        {richContent ? (
          <code
            code={preview.content}
            language="json"
            style={collapsed ? { lineClamp: TOOL_OUTPUT_COLLAPSED_LINES } : undefined}
          />
        ) : (
          <text style={collapsed ? { lineClamp: TOOL_OUTPUT_COLLAPSED_LINES } : undefined}>
            {preview.content}
          </text>
        )}
        {preview.remainingCharacters > 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <text style={{ color: colors.muted, fontSize: 11 }}>
              {`${preview.remainingCharacters.toLocaleString()} characters hidden`}
            </text>
            <NativeButton
              testId={`tool-output-more-${toolCall.id}`}
              onPress={() =>
                setRequestedCharacters((current) =>
                  nextToolOutputPreviewLength(current, content.length),
                )
              }
            >
              <text>{collapsed ? 'Show output' : 'Show more'}</text>
            </NativeButton>
          </div>
        ) : null}
        {preview.visibleCharacters > TOOL_OUTPUT_COLLAPSED_CHARACTERS ? (
          <NativeButton
            testId={`tool-output-collapse-${toolCall.id}`}
            onPress={() => setRequestedCharacters(TOOL_OUTPUT_COLLAPSED_CHARACTERS)}
          >
            <text>Collapse output</text>
          </NativeButton>
        ) : null}
      </ToolCallCard>
    </ConversationRow>
  );
});

interface MessageRowProps {
  message: ThreadWorkspaceData['messagesById'][string] | undefined;
  messageId: string;
  richContent: boolean;
}

export const NATIVE_DIFF_INITIAL_MAX_LINES = 120;

export function ExpandableNativeDiff({
  patch,
  testId,
}: {
  patch: string;
  testId?: string;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const showAllLines = useCallback(() => setExpanded(true), []);
  return (
    <diff
      testId={testId}
      patch={patch}
      wordDiff
      maxLines={expanded ? undefined : NATIVE_DIFF_INITIAL_MAX_LINES}
      onShowMore={expanded ? undefined : showAllLines}
    />
  );
}

export function areMessageRowsEqual(previous: MessageRowProps, next: MessageRowProps): boolean {
  return (
    previous.message === next.message &&
    previous.messageId === next.messageId &&
    previous.richContent === next.richContent
  );
}

type RowMessage = MessageRowProps['message'];

function hasTextContent(
  message: RowMessage,
): message is NonNullable<RowMessage> & { content: string } {
  return typeof message?.content === 'string';
}

export const MessageRow = memo(function MessageRow({
  message,
  messageId,
  richContent,
}: MessageRowProps) {
  const colors = useNativeColors();
  const content = hasTextContent(message) ? message.content : '';
  const [requestedCharacters, setRequestedCharacters] = useState(
    MESSAGE_CONTENT_COLLAPSED_CHARACTERS,
  );
  const preview = createMessageContentPreview(content, requestedCharacters);
  if (!hasTextContent(message)) {
    return (
      <ConversationRow>
        <StatusCard title="Unsupported message" detail={messageId} tone="danger" />
      </ConversationRow>
    );
  }
  const collapsed = requestedCharacters <= MESSAGE_CONTENT_COLLAPSED_CHARACTERS;
  const renderRichAssistant = assistantMessageUsesRichPresentation(richContent, message.delivery);
  const diff = preview.remainingCharacters === 0 ? extractDiff(content) : null;
  const body = (
    <>
      {message.role === 'user' ? (
        <text
          style={{
            color: colors.inverseText,
            lineClamp: collapsed ? MESSAGE_CONTENT_COLLAPSED_LINES : undefined,
          }}
        >
          {preview.content}
        </text>
      ) : (
        <AssistantMessage source={preview.content} rich={renderRichAssistant} />
      )}
      {preview.remainingCharacters > 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <text
            style={{
              color: message.role === 'user' ? colors.inverseText : colors.muted,
              fontSize: 11,
            }}
          >
            {`${preview.remainingCharacters.toLocaleString()} message characters hidden`}
          </text>
          <NativeButton
            testId={`message-content-more-${message.id}`}
            variant="ghost"
            size="small"
            onPress={() =>
              setRequestedCharacters((current) =>
                nextMessageContentPreviewLength(current, content.length),
              )
            }
          >
            <text>{collapsed ? 'Show message' : 'Show more'}</text>
          </NativeButton>
        </div>
      ) : null}
      {preview.visibleCharacters > MESSAGE_CONTENT_COLLAPSED_CHARACTERS ? (
        <NativeButton
          testId={`message-content-collapse-${message.id}`}
          variant="ghost"
          size="small"
          onPress={() => setRequestedCharacters(MESSAGE_CONTENT_COLLAPSED_CHARACTERS)}
        >
          <text>Collapse message</text>
        </NativeButton>
      ) : null}
      {renderRichAssistant && diff ? (
        <ExpandableNativeDiff testId={`message-diff-${message.id}`} patch={diff} />
      ) : null}
      {message.images?.length ? (
        <text style={{ color: colors.warning }}>Attachments: {message.images.length}</text>
      ) : null}
    </>
  );
  return (
    <ConversationRow testId={`message-${message.id}`}>
      {message.role === 'user' ? <UserMessageCard>{body}</UserMessageCard> : body}
    </ConversationRow>
  );
}, areMessageRowsEqual);
