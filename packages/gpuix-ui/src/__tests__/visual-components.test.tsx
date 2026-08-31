import { describe, expect, test } from 'bun:test';

import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing';

import { Button } from '../button';
import { ComposerActions, ComposerSelect, PromptComposer, PromptEditorSurface } from '../composer';
import { AssistantMessage, ConversationRow, UserMessageCard } from '../conversation';
import { ICON_NAMES, Icon, iconSource } from '../icon';
import {
  DiffStats,
  gitChangesIndicatorKind,
  GitChangesSummary,
  Powerline,
  PowerlineSegment,
} from '../powerline';
import {
  ProjectGroup,
  SidebarDisclosureSection,
  SidebarFooter,
  SidebarProfile,
  SidebarSection,
  SidebarShell,
  ThreadListItem,
} from '../sidebar';
import { StatusCard } from '../status-card';
import { GpuixUiProvider } from '../theme';
import { ThreadHeader } from '../thread-header';

describe('visual component contracts', () => {
  test('provides deterministic SVG for every semantic icon', () => {
    for (const name of ICON_NAMES) {
      const source = iconSource(name, '#ffffff');
      expect(source).toContain('<svg');
      expect(source).toContain('stroke="#ffffff"');
    }
  });

  test('distinguishes loading, clean, and changed git summaries', () => {
    expect(gitChangesIndicatorKind(null, null, null)).toBe('loading');
    expect(gitChangesIndicatorKind(0, 0, 0)).toBe('clean');
    expect(gitChangesIndicatorKind(2, 14, 3)).toBe('changed');
  });

  const nativeTest = hasNativeTestRenderer ? test : test.skip;

  nativeTest('renders the shared thread anatomy and keyboard activation', () => {
    let activations = 0;
    const root = createTestRoot({ width: 960, height: 720 });
    root.render(
      <GpuixUiProvider>
        <div style={{ width: 900, height: 680 }}>
          <ThreadHeader
            testId="header"
            title="Visual parity"
            leading={<Icon name="navigation" />}
          />
          <SidebarSection title="PROJECTS">
            <ThreadListItem
              testId="thread-row"
              title="Selected thread"
              selected
              status="running"
              onSelect={() => activations++}
            />
          </SidebarSection>
          <SidebarShell testId="sidebar-shell">
            <SidebarDisclosureSection testId="activity-section" title="ACTIVITY">
              <ThreadListItem title="Recent thread" time="23m" onSelect={() => activations++} />
            </SidebarDisclosureSection>
            <ProjectGroup title="Funny">
              <ThreadListItem
                title="Project thread"
                status="completed"
                metadata={
                  <Powerline>
                    <PowerlineSegment icon={<Icon name="branch" />}>master</PowerlineSegment>
                    <DiffStats files={2} added={14} deleted={3} />
                  </Powerline>
                }
                onSelect={() => activations++}
              />
            </ProjectGroup>
            <SidebarFooter>
              <GitChangesSummary
                testId="changes-summary"
                label="main"
                files={2}
                added={14}
                deleted={3}
              />
              <SidebarProfile name="Ada Lovelace" username="ada" />
            </SidebarFooter>
          </SidebarShell>
          <ConversationRow testId="conversation-row">
            <UserMessageCard testId="user-card" onActivate={() => activations++}>
              <text>User prompt</text>
            </UserMessageCard>
          </ConversationRow>
          <ConversationRow>
            <AssistantMessage source="Assistant response" />
            <StatusCard testId="status-card" title="Tool" status="completed" />
          </ConversationRow>
          <PromptComposer testId="composer">
            <PromptEditorSurface>
              <text>Draft</text>
            </PromptEditorSurface>
            <ComposerActions>
              <ComposerSelect
                value="codex"
                items={[{ value: 'codex', label: 'Codex' }]}
                onValueChange={() => undefined}
              />
              <Button testId="send" onPress={() => activations++}>
                <text>Send</text>
              </Button>
            </ComposerActions>
          </PromptComposer>
        </div>
      </GpuixUiProvider>,
    );

    expect(root.renderer.findByTestId('conversation-row')?.style.maxWidth).toBe(768);
    expect(root.renderer.findByTestId('composer')?.style.maxWidth).toBe(768);
    expect(root.renderer.findByTestId('user-card')?.style.backgroundColor).toBe('#c8cbd0');
    expect(root.renderer.findByTestId('status-card')?.style.borderRadius).toBe(8);
    expect(root.renderer.findByTestId('sidebar-shell')?.style.width).toBe(300);
    expect(root.renderer.getPaintedText()).toContain('ACTIVITY');
    expect(root.renderer.getPaintedText()).toContain('@ada');
    expect(root.renderer.getPaintedText()).toContain('+14');
    expect(root.renderer.findByTestId('changes-summary')).not.toBeNull();

    const row = root.renderer.findByTestId('thread-row');
    if (row) root.renderer.nativeSimulateKeyDown(row.id, 'enter');
    expect(activations).toBe(1);
    const userCard = root.renderer.findByTestId('user-card');
    if (userCard) root.renderer.nativeSimulateKeyDown(userCard.id, 'enter');
    expect(activations).toBe(2);
    root.unmount();
  });
});
