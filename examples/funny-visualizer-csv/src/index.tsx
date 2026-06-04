// Reference funny visualizer plugin (authoring source).
//
// Demonstrates the full host↔plugin contract:
//   - peerDependencies on `react` + `@funny/host` (bare ESM imports; the funny
//     host's import map resolves them to its own instances at runtime),
//   - a default-exported `VisualizerPlugin`,
//   - using a host hook (`useFunnyTheme`) — valid because the plugin shares the
//     host's React tree.
//
// Build to ESM with `npm run build` (esbuild externalizes react + @funny/host),
// then drop the package into `~/.funny/extensions/funny-visualizer-csv/`.
import { useFunnyTheme, type VisualizerPlugin, type VisualizerProps } from '@funny/host';

/** Minimal RFC-4180-ish CSV parse: handles quoted fields, escaped quotes, and
 *  commas/newlines inside quotes. Good enough for a reference visualizer. */
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

function CsvTable({ source }: VisualizerProps) {
  const theme = useFunnyTheme();
  const rows = parseCsv(source);
  if (rows.length === 0) {
    return <div className="text-muted-foreground text-sm">Empty CSV</div>;
  }
  const [header, ...body] = rows;
  const border = theme === 'dark' ? '#333' : '#ddd';
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: 'var(--diff-font-size, 13px)' }}>
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th
                key={i}
                style={{ border: `1px solid ${border}`, padding: '4px 8px', textAlign: 'left' }}
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
                <td key={ci} style={{ border: `1px solid ${border}`, padding: '4px 8px' }}>
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

const plugin: VisualizerPlugin = {
  id: 'funny-visualizer-csv',
  version: '0.1.0',
  contributes: { fences: ['csv'], fileExtensions: ['.csv'] },
  Component: CsvTable,
};

export default plugin;
