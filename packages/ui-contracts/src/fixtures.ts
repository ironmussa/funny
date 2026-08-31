import type { VisualDensity, VisualThemeName } from './tokens';

export type ViewportClass = 'desktop' | 'compact';
export type ThreadVisualStatus =
  | 'idle'
  | 'setting-up'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed';
export type ComposerLifecycle = 'idle' | 'pending' | 'running' | 'waiting' | 'read-only' | 'error';
export type ActivityKind = 'tool' | 'todo' | 'permission' | 'connection';

export interface NavigationFixtureRow {
  id: string;
  kind: 'project' | 'thread';
  label: string;
  section: 'activity' | 'scratch' | 'projects' | 'shared';
  selected?: boolean;
  expanded?: boolean;
  status?: ThreadVisualStatus;
  metadata?: string[];
}

export interface ConversationFixtureItem {
  id: string;
  kind: 'user' | 'assistant' | ActivityKind | 'unsupported';
  title?: string;
  content: string;
  status?: ThreadVisualStatus | 'active' | 'resolved' | 'disconnected';
  collapsed?: boolean;
}

export interface VisualParityFixture {
  id: string;
  theme: VisualThemeName;
  density: VisualDensity;
  viewport: ViewportClass;
  threadTitle: string;
  navigation: NavigationFixtureRow[];
  conversation: ConversationFixtureItem[];
  composer: { lifecycle: ComposerLifecycle; value: string; model: string; mode: string };
  diagnostics: boolean;
}

const navigation: NavigationFixtureRow[] = [
  {
    id: 'scratch',
    kind: 'thread',
    label: 'Quick decision',
    section: 'scratch',
    status: 'completed',
  },
  { id: 'project', kind: 'project', label: 'funny', section: 'projects', expanded: true },
  {
    id: 'thread',
    kind: 'thread',
    label: 'Align GPUIX visual system',
    section: 'projects',
    selected: true,
    status: 'running',
    metadata: ['main', '+42', '-8'],
  },
];

const conversation: ConversationFixtureItem[] = [
  { id: 'user', kind: 'user', content: 'Make the GPUIX client match the React thread view.' },
  {
    id: 'assistant',
    kind: 'assistant',
    content: '## Visual alignment\n\nThe conversation and composer now share one centered column.',
  },
  {
    id: 'tool',
    kind: 'tool',
    title: 'Read',
    content: 'packages/client-gpuix/src/app.tsx',
    status: 'completed',
  },
  {
    id: 'todo',
    kind: 'todo',
    title: 'Implementation',
    content: '3/4 tasks complete',
    status: 'running',
  },
  {
    id: 'permission',
    kind: 'permission',
    title: 'Permission required',
    content: 'Allow command execution?',
    status: 'active',
  },
];

export const desktopParityFixture: VisualParityFixture = {
  id: 'thread-desktop-reference-dark',
  theme: 'reference-dark',
  density: 'compact',
  viewport: 'desktop',
  threadTitle: 'Align GPUIX visual system',
  navigation,
  conversation,
  composer: { lifecycle: 'idle', value: '', model: 'Codex', mode: 'Auto Edit' },
  diagnostics: false,
};

export const compactParityFixture: VisualParityFixture = {
  ...desktopParityFixture,
  id: 'thread-compact-running-reference-dark',
  viewport: 'compact',
  composer: { ...desktopParityFixture.composer, lifecycle: 'running' },
};

export const visualParityFixtures = [desktopParityFixture, compactParityFixture] as const;
