# @funny/gpuix-ui

Composable, themeable UI components for React applications rendered by GPUIX.
The package follows the shadcn model: source-level components, explicit exports,
and application-owned visual tokens instead of a global stylesheet.

Import components through their subpaths so consumers only load what they use:

```tsx
import { Button } from '@funny/gpuix-ui/button';
import { Input } from '@funny/gpuix-ui/input';
import { gpuixTheme, GpuixUiProvider } from '@funny/gpuix-ui/theme';

<GpuixUiProvider theme={gpuixTheme('one-dark')}>
  <Input value={name} onValueChange={setName} placeholder="Name" />
  <Button onPress={save}>Save</Button>
</GpuixUiProvider>;
```

`one-dark` matches React's default named theme. `darkTheme` remains a compatible
alias for `oneDarkTheme`; new consumers should resolve named contracts with
`gpuixTheme(name)`.

The package consumes renderer-neutral values from `@funny/ui-contracts`; it never
imports Funny stores, commands, or transport services. Product packages adapt
domain state into primitive props at their composition boundary.

Available subpaths: `badge`, `button`, `card`, `composer`, `conversation`, `dock-layout`,
`dock-layout-model`, `file-tree`, `file-tree-model`, `icon`, `input`, `layout`, `nav-item`,
`powerline`, `select`, `separator`, `sidebar`, `status-card`, `theme`, `thread-header`, and
`tooltip`.

`DockLayout` is a native compound component for reorderable and resizable panels:

```tsx
<DockLayout.Root defaultValue={savedLayout} onValueCommit={saveLayout}>
  <DockLayout.Panel id="navigation" defaultSize={300} minSize={260}>
    <DockLayout.Handle>Navigation</DockLayout.Handle>
    <Navigation />
  </DockLayout.Panel>
  <DockLayout.Panel id="conversation" minSize={400}>
    <DockLayout.Handle>Conversation</DockLayout.Handle>
    <Conversation />
  </DockLayout.Panel>
</DockLayout.Root>
```

Dragging a handle reorders panels; dragging the generated separator resizes adjacent panels.
`onValueChange` reports live changes and `onValueCommit` fires once when the gesture ends, which is
the appropriate persistence boundary. The serializable `{ order, sizes }` model is exported
separately so applications can validate stored layouts without importing React.

`FileTree` renders a renderer-native, virtualized repository tree from a flat list of relative file
paths. It owns folder disclosure state by default, supports controlled disclosure, filtering and
file selection, and has no dependency on the DOM-oriented React `FileTree`. Filtering temporarily
expands matching descendants so collapsed folders cannot hide results.

The supported native thread anatomy is:

```text
SidebarShell
├── SidebarBody
│   ├── SidebarDisclosureSection (activity/shared)
│   ├── SidebarSection (projects)
│   │   └── ProjectGroup
│   │       └── ThreadListItem
│   └── ProjectGroup (quick chats)
└── SidebarFooter
    └── SidebarProfile

ThreadHeader + ConversationRow[] + PromptComposer
```

Sidebar state remains application-owned. The client supplies project expansion,
selection, thread status, relative time, branch metadata, summaries, user
identity, and actions; these components only own local disclosure state when no
controlled value is provided. Unsupported web-only metadata is omitted instead
of rendered as a placeholder.

`Powerline`, `PowerlineSegment`, and `DiffStats` compose project, base-branch,
worktree-branch, dirty-file, added-line, and deleted-line metadata without
coupling the package to the Git API. `StatusPin` maps thread lifecycle variants
to compact native icons and colors.

`ConversationRow` and `PromptComposer` share the 768 logical-pixel reference
column. `UserMessageCard` uses the inverse surface, while `AssistantMessage`
renders directly on the conversation canvas. Diagnostic controls belong to the
client diagnostic surface, not these product components.
