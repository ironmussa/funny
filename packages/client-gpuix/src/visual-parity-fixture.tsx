import {
  PromptComposer,
  PromptEditorSurface,
  ComposerActions,
  ComposerContext,
} from '@funny/gpuix-ui/composer';
import { AssistantMessage, ConversationRow, UserMessageCard } from '@funny/gpuix-ui/conversation';
import { Icon } from '@funny/gpuix-ui/icon';
import { SidebarSection, SidebarShell, ThreadListItem } from '@funny/gpuix-ui/sidebar';
import { StatusCard } from '@funny/gpuix-ui/status-card';
import { GpuixUiProvider } from '@funny/gpuix-ui/theme';
import { ThreadHeader } from '@funny/gpuix-ui/thread-header';
import type { VisualParityFixture } from '@funny/ui-contracts/fixtures';
import type { ReactElement } from 'react';

export function GpuixVisualParityFixtureHost({
  fixture,
}: {
  fixture: VisualParityFixture;
}): ReactElement {
  const compact = fixture.viewport === 'compact';
  return (
    <GpuixUiProvider>
      <div
        testId={`parity-fixture-${fixture.id}`}
        style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%' }}
      >
        {compact ? null : (
          <SidebarShell testId="parity-navigation">
            {(['activity', 'scratch', 'projects', 'shared'] as const).map((section) => {
              const rows = fixture.navigation.filter((row) => row.section === section);
              return rows.length ? (
                <SidebarSection key={section} title={section.toUpperCase()}>
                  {rows.map((row) => (
                    <ThreadListItem
                      key={row.id}
                      testId={`parity-navigation-${row.id}`}
                      title={row.label}
                      selected={row.selected}
                      status={row.status?.replace('-', '_') as never}
                      onSelect={() => undefined}
                    />
                  ))}
                </SidebarSection>
              ) : null;
            })}
          </SidebarShell>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <ThreadHeader
            testId="parity-header"
            title={fixture.threadTitle}
            leading={<Icon name="navigation" />}
          />
          <virtual-list
            itemCount={fixture.conversation.length}
            estimatedItemHeight={120}
            style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
          >
            {fixture.conversation.map((item) => (
              <ConversationRow
                key={item.id}
                testId={`parity-conversation-${item.id}`}
                compact={compact}
              >
                {item.kind === 'user' ? (
                  <UserMessageCard>
                    <text>{item.content}</text>
                  </UserMessageCard>
                ) : item.kind === 'assistant' ? (
                  <AssistantMessage source={item.content} />
                ) : (
                  <StatusCard
                    title={item.title ?? item.kind}
                    detail={item.content}
                    status={item.status}
                    tone={item.kind === 'permission' ? 'warning' : 'neutral'}
                  />
                )}
              </ConversationRow>
            ))}
          </virtual-list>
          <div style={{ padding: compact ? 8 : 16 }}>
            <PromptComposer testId="parity-composer" lifecycle={fixture.composer.lifecycle}>
              <PromptEditorSurface>
                <text>{fixture.composer.value || 'Send a message…'}</text>
              </PromptEditorSurface>
              <ComposerActions>
                <ComposerContext>
                  <text>
                    {fixture.composer.model} · {fixture.composer.mode}
                  </text>
                </ComposerContext>
                <Icon name={fixture.composer.lifecycle === 'running' ? 'stop' : 'send'} />
              </ComposerActions>
            </PromptComposer>
          </div>
        </div>
      </div>
    </GpuixUiProvider>
  );
}
