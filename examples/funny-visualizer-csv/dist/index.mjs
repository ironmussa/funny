// Pre-built ESM bundle of funny-visualizer-csv (hand-authored equivalent of the
// esbuild output of src/index.tsx). Imports `react` and `@funny/host` as bare
// specifiers — the funny host's import map resolves them to its own instances.
// Drop this package into ~/.funny/extensions/funny-visualizer-csv/ to install.
import React from 'react';
import { useFunnyTheme } from '@funny/host';

const h = React.createElement;

function parseCsv(input) {
  const rows = [];
  let row = [];
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

function CsvTable({ source }) {
  const theme = useFunnyTheme();
  const rows = parseCsv(source);
  if (rows.length === 0) {
    return h('div', { className: 'text-muted-foreground text-sm' }, 'Empty CSV');
  }
  const [header, ...body] = rows;
  const border = theme === 'dark' ? '#333' : '#ddd';
  return h(
    'div',
    { style: { overflowX: 'auto' } },
    h(
      'table',
      { style: { borderCollapse: 'collapse', fontSize: 'var(--diff-font-size, 13px)' } },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          header.map((cell, i) =>
            h(
              'th',
              { key: i, style: { border: `1px solid ${border}`, padding: '4px 8px', textAlign: 'left' } },
              cell,
            ),
          ),
        ),
      ),
      h(
        'tbody',
        null,
        body.map((r, ri) =>
          h(
            'tr',
            { key: ri },
            r.map((cell, ci) =>
              h('td', { key: ci, style: { border: `1px solid ${border}`, padding: '4px 8px' } }, cell),
            ),
          ),
        ),
      ),
    ),
  );
}

const plugin = {
  id: 'funny-visualizer-csv',
  version: '0.1.0',
  contributes: { fences: ['csv'], fileExtensions: ['.csv'] },
  Component: CsvTable,
};

export default plugin;
