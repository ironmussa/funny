// React Flow node for a DBML table. Decoupled version of funny's internal
// dbml-schema-node: plain elements + Tailwind design tokens (funny's CSS styles
// them at runtime) instead of shadcn Card/Badge/Tooltip.
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo } from 'react';

const cn = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(' ');

export const DBML_TABLE_NODE_TYPE = 'dbmlTable';
export const DBML_NODE_WIDTH = 260;
export const DBML_HEADER_HEIGHT = 44;
export const DBML_HEADER_NOTE_EXTRA = 18;
export const DBML_ROW_HEIGHT = 28;
export const DBML_ROW_NOTE_EXTRA = 16;

export type DbmlSchemaColumn = {
  title: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  notNull?: boolean;
  note?: string;
  fk?: boolean;
  fkTarget?: string;
};

export type DbmlTableNodeData = {
  label: string;
  schema: DbmlSchemaColumn[];
  headerColor?: string;
  note?: string;
};

export function columnRowHeight(col: DbmlSchemaColumn): number {
  return col.note ? DBML_ROW_HEIGHT + DBML_ROW_NOTE_EXTRA : DBML_ROW_HEIGHT;
}

export function tableHeaderHeight(data: Pick<DbmlTableNodeData, 'note'>): number {
  return data.note ? DBML_HEADER_HEIGHT + DBML_HEADER_NOTE_EXTRA : DBML_HEADER_HEIGHT;
}

export function tableNodeHeightFromData(data: DbmlTableNodeData): number {
  const header = tableHeaderHeight(data);
  const rows = data.schema.reduce((sum, col) => sum + columnRowHeight(col), 0);
  return header + rows + 8;
}

const BADGE_BASE = 'inline-flex h-4 items-center rounded px-1 text-xs font-medium leading-none';

function DbmlSchemaNodeComponent({ data }: NodeProps<Node<DbmlTableNodeData>>) {
  const headerStyle = data.headerColor
    ? { backgroundColor: data.headerColor, color: '#fff' }
    : undefined;

  return (
    <div
      className="nodrag nopan border-border bg-card w-[260px] overflow-hidden rounded-lg border shadow-md"
      data-testid={`dbml-table-${data.label}`}
    >
      <div
        className={cn(
          'border-b border-border px-3 py-2',
          !data.headerColor && 'bg-primary text-primary-foreground',
        )}
        style={headerStyle}
      >
        <div className="text-sm leading-tight font-semibold">{data.label}</div>
        {data.note && (
          <p
            className={cn(
              'mt-0.5 line-clamp-2 text-xs leading-snug',
              data.headerColor ? 'opacity-90' : 'text-primary-foreground/80',
            )}
          >
            {data.note}
          </p>
        )}
      </div>
      <div>
        <ul className="divide-border divide-y">
          {data.schema.map((col) => (
            <li
              key={col.title}
              className="relative flex items-start gap-2 px-3 py-1.5 text-xs"
              style={{ minHeight: columnRowHeight(col) }}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={col.title}
                className="!border-border !bg-muted-foreground !top-3 !h-2 !w-2"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-foreground truncate font-mono">{col.title}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {col.pk && (
                      <span className={cn(BADGE_BASE, 'bg-secondary text-secondary-foreground')}>
                        PK
                      </span>
                    )}
                    {col.fk && (
                      <span
                        className={cn(BADGE_BASE, 'border border-border')}
                        title={col.fkTarget ? `→ ${col.fkTarget}` : undefined}
                      >
                        FK
                      </span>
                    )}
                    <span className="text-muted-foreground">{col.type}</span>
                  </span>
                </div>
                {col.note && (
                  <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-snug">
                    {col.note}
                  </p>
                )}
              </div>
              <Handle
                type="source"
                position={Position.Right}
                id={col.title}
                className="!border-border !bg-muted-foreground !top-3 !h-2 !w-2"
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export const DbmlSchemaNode = memo(DbmlSchemaNodeComponent);
