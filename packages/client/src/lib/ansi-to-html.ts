/**
 * Security M6: a single place to construct `ansi-to-html` converters so that
 * `escapeXML` is forced on and cannot be accidentally omitted at a call site.
 * Every converter output is passed through `dangerouslySetInnerHTML`, so any
 * instance that forgot `escapeXML: true` would let a `<script>` in terminal
 * output execute. Callers must use this helper and should not import the
 * `ansi-to-html` package directly.
 */

import AnsiToHtml from 'ansi-to-html';

export type AnsiConverterOptions = Omit<ConstructorParameters<typeof AnsiToHtml>[0], 'escapeXML'>;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  'g',
);

/**
 * Build an ansi-to-html converter. `escapeXML` is always `true`; callers do
 * not get a knob to turn it off.
 */
export function createAnsiConverter(options: AnsiConverterOptions = {}): AnsiToHtml {
  return new AnsiToHtml({ ...options, escapeXML: true });
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
