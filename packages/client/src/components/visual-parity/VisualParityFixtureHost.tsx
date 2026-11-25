import type { VisualParityFixture } from '@funny/ui-contracts/fixtures';
import { referenceDark } from '@funny/ui-contracts/tokens';

import { cn } from '@/lib/utils';

export function VisualParityFixtureHost({ fixture }: { fixture: VisualParityFixture }) {
  const compact = fixture.viewport === 'compact';
  const { colors, layout, radii } = referenceDark;
  return (
    <div
      data-testid={`parity-fixture-${fixture.id}`}
      data-viewport={fixture.viewport}
      className={cn(
        'flex [background:var(--parity-canvas)] text-[color:var(--parity-text)]',
        compact ? 'h-[760px] w-[720px]' : 'h-[900px] w-[1440px]',
      )}
      // The fixture renders the visual contract's own values, not the app theme:
      // they are set once here as custom properties and read by the classes below.
      style={{
        '--parity-canvas': colors.canvas,
        '--parity-text': colors.text,
        '--parity-sidebar': colors.sidebar,
        '--parity-surface-raised': colors.surfaceRaised,
        '--parity-border': colors.border,
        '--parity-inverse-surface': colors.inverseSurface,
        '--parity-inverse-text': colors.inverseText,
        '--parity-sidebar-width': `${layout.sidebarWidth}px`,
        '--parity-header-height': `${layout.headerHeight}px`,
        '--parity-conversation-max-width': `${layout.conversationMaximumWidth}px`,
        '--parity-composer-max-width': `${layout.composerMaximumWidth}px`,
        '--parity-radius-medium': `${radii.medium}px`,
        '--parity-radius-large': `${radii.large}px`,
      }}
    >
      {!compact && (
        <aside
          data-parity-role="navigation"
          className="w-[var(--parity-sidebar-width)] p-2 [background:var(--parity-sidebar)] [border-right:1px_solid_var(--parity-border)]"
        >
          {fixture.navigation.map((row) => (
            <div
              key={row.id}
              data-parity-id={row.id}
              data-selected={row.selected || undefined}
              className={cn(
                'mb-1 rounded-[var(--parity-radius-medium)] px-2 py-1.5',
                row.selected
                  ? '[background:var(--parity-surface-raised)]'
                  : '[background:transparent]',
              )}
            >
              {row.label}
            </div>
          ))}
        </aside>
      )}
      <main className="flex min-w-0 flex-1 flex-col">
        <header
          data-parity-role="thread-header"
          className="min-h-[var(--parity-header-height)] px-3 py-0 [border-bottom:1px_solid_var(--parity-border)]"
        >
          {fixture.threadTitle}
        </header>
        <section
          data-parity-role="conversation"
          className={cn('flex-1 overflow-auto', compact ? 'p-2' : 'p-4')}
        >
          <div className="mx-auto my-0 max-w-[var(--parity-conversation-max-width)]">
            {fixture.conversation.map((item) => (
              <article
                key={item.id}
                data-parity-id={item.id}
                data-kind={item.kind}
                className={cn(
                  'mx-0 mt-0 mb-4 rounded-[var(--parity-radius-large)]',
                  item.kind === 'assistant' ? 'p-0' : 'p-3',
                  item.kind === 'user'
                    ? 'text-[color:var(--parity-inverse-text)] [background:var(--parity-inverse-surface)]'
                    : 'text-[color:var(--parity-text)]',
                  item.kind === 'assistant' && '[background:transparent]',
                  item.kind !== 'user' &&
                    item.kind !== 'assistant' &&
                    '[border:1px_solid_var(--parity-border)] [background:var(--parity-sidebar)]',
                )}
              >
                {item.title && <strong>{item.title}</strong>}
                <div>{item.content}</div>
              </article>
            ))}
          </div>
        </section>
        <footer
          data-parity-role="composer"
          data-lifecycle={fixture.composer.lifecycle}
          className="mx-auto mt-0 mb-4 w-[calc(100%-32px)] max-w-[var(--parity-composer-max-width)] rounded-[var(--parity-radius-medium)] p-2.5 [background:var(--parity-surface-raised)] [border:1px_solid_var(--parity-border)]"
        >
          <div>{fixture.composer.value || 'Send a message…'}</div>
          <small>
            {fixture.composer.model} · {fixture.composer.mode}
          </small>
        </footer>
      </main>
    </div>
  );
}
