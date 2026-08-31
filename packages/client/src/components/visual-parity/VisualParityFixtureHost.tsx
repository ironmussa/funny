import type { VisualParityFixture } from '@funny/ui-contracts/fixtures';
import { referenceDark } from '@funny/ui-contracts/tokens';

export function VisualParityFixtureHost({ fixture }: { fixture: VisualParityFixture }) {
  const compact = fixture.viewport === 'compact';
  return (
    <div
      data-testid={`parity-fixture-${fixture.id}`}
      data-viewport={fixture.viewport}
      style={{
        display: 'flex',
        width: compact ? 720 : 1440,
        height: compact ? 760 : 900,
        color: referenceDark.colors.text,
        background: referenceDark.colors.canvas,
      }}
    >
      {!compact && (
        <aside
          data-parity-role="navigation"
          style={{
            width: referenceDark.layout.sidebarWidth,
            padding: 8,
            background: referenceDark.colors.sidebar,
            borderRight: `1px solid ${referenceDark.colors.border}`,
          }}
        >
          {fixture.navigation.map((row) => (
            <div
              key={row.id}
              data-parity-id={row.id}
              data-selected={row.selected || undefined}
              style={{
                marginBottom: 4,
                padding: '6px 8px',
                borderRadius: referenceDark.radii.medium,
                background: row.selected ? referenceDark.colors.surfaceRaised : 'transparent',
              }}
            >
              {row.label}
            </div>
          ))}
        </aside>
      )}
      <main style={{ display: 'flex', minWidth: 0, flex: 1, flexDirection: 'column' }}>
        <header
          data-parity-role="thread-header"
          style={{
            minHeight: referenceDark.layout.headerHeight,
            padding: '0 12px',
            borderBottom: `1px solid ${referenceDark.colors.border}`,
          }}
        >
          {fixture.threadTitle}
        </header>
        <section
          data-parity-role="conversation"
          style={{ flex: 1, overflow: 'auto', padding: compact ? 8 : 16 }}
        >
          <div
            style={{ maxWidth: referenceDark.layout.conversationMaximumWidth, margin: '0 auto' }}
          >
            {fixture.conversation.map((item) => (
              <article
                key={item.id}
                data-parity-id={item.id}
                data-kind={item.kind}
                style={{
                  margin: '0 0 16px',
                  padding: item.kind === 'user' || !['assistant'].includes(item.kind) ? 12 : 0,
                  borderRadius: referenceDark.radii.large,
                  color:
                    item.kind === 'user'
                      ? referenceDark.colors.inverseText
                      : referenceDark.colors.text,
                  background:
                    item.kind === 'user'
                      ? referenceDark.colors.inverseSurface
                      : item.kind === 'assistant'
                        ? 'transparent'
                        : referenceDark.colors.sidebar,
                  border:
                    item.kind === 'assistant' || item.kind === 'user'
                      ? undefined
                      : `1px solid ${referenceDark.colors.border}`,
                }}
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
          style={{
            width: 'calc(100% - 32px)',
            maxWidth: referenceDark.layout.composerMaximumWidth,
            margin: '0 auto 16px',
            padding: 10,
            border: `1px solid ${referenceDark.colors.border}`,
            borderRadius: referenceDark.radii.medium,
            background: referenceDark.colors.surfaceRaised,
          }}
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
