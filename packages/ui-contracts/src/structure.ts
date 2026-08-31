import type { VisualParityFixture } from './fixtures';

export interface ParityStructure {
  fixtureId: string;
  viewport: string;
  navigationIds: string[];
  conversationIds: string[];
  composerLifecycle: string;
  diagnostics: boolean;
}

export function expectedParityStructure(fixture: VisualParityFixture): ParityStructure {
  return {
    fixtureId: fixture.id,
    viewport: fixture.viewport,
    navigationIds: fixture.navigation.map((row) => row.id),
    conversationIds: fixture.conversation.map((item) => item.id),
    composerLifecycle: fixture.composer.lifecycle,
    diagnostics: fixture.diagnostics,
  };
}
