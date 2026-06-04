import { useMemo } from 'react';

import { cn } from '@/lib/utils';

/** Minimal RFC-4180-ish CSV parse: handles quoted fields, escaped quotes, and
 *  commas / newlines inside quotes. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

/**
 * Built-in CSV visualizer: renders `csv` fenced blocks and `.csv` file previews
 * as a table. No dependencies — cheap enough to ship in the base bundle (still
 * lazy-loaded via the visualizer registry). Font size scales with the diff CSS
 * variable; theme comes from the surrounding CSS variables.
 */
export function CsvTable({ source, fill }: { source: string; fill?: boolean }) {
  const rows = useMemo(() => parseCsv(source), [source]);

  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground">Empty CSV</div>;
  }

  const [header, ...body] = rows;

  return (
    <div className={cn('overflow-auto', fill && 'h-full')} data-testid="csv-table">
      <table className="border-collapse text-[length:var(--diff-font-size,13px)]">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                className="border border-border bg-muted/50 px-2 py-1 text-left font-medium"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td key={ci} className="border border-border px-2 py-1 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
