import type { ImageAttachment } from '@funny/shared';

import type { Annotation } from '@/stores/browser-panel-store';

const COLOR_NAMES: Record<string, string> = {
  '#ef4444': 'red',
  '#f59e0b': 'amber',
  '#22c55e': 'green',
  '#3b82f6': 'blue',
  '#ffffff': 'white',
};

const colorName = (hex: string): string => COLOR_NAMES[hex.toLowerCase()] ?? hex;

const TITLE_MAX = 80;
const MD_URL_MAX = 200;

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

export function annotationsToTitle(url: string): string {
  return truncate(`Annotated: ${url}`, TITLE_MAX);
}

function summarize(a: Annotation): string {
  switch (a.kind) {
    case 'pin':
      return `pin @ (${a.x}, ${a.y})`;
    case 'region':
      return `region @ (${a.x}, ${a.y}, ${a.w}×${a.h})`;
    case 'draw':
      return `draw (${colorName(a.color)})`;
  }
}

export function annotationsToMarkdown(url: string, annotations: Annotation[]): string {
  const displayUrl = truncate(url, MD_URL_MAX);
  const lines: string[] = [`# Annotated URL: ${displayUrl}`];

  annotations.forEach((a, i) => {
    lines.push('', `## Annotation ${i + 1} — ${summarize(a)}`);
    const note = a.note.trim();
    if (note.length > 0) {
      lines.push(note);
    }

    // CDP-mode enrichment: surface the DOM element data the agent needs to
    // locate code. Absent on legacy iframe annotations.
    if (a.kind === 'pin' && a.dom) {
      lines.push('', '### Element');
      lines.push(`- selector: \`${a.dom.selector}\``);
      if (a.dom.testid) lines.push(`- data-testid: \`${a.dom.testid}\``);
      if (a.dom.componentName) lines.push(`- component: \`${a.dom.componentName}\``);
      if (a.dom.text) lines.push(`- text: "${a.dom.text}"`);
    }
    if (a.kind === 'region' && a.dom && a.dom.elements.length > 0) {
      lines.push('', '### Candidate elements');
      for (const el of a.dom.elements.slice(0, 5)) {
        const tid = el.testid ? ` (data-testid="${el.testid}")` : '';
        const comp = el.componentName ? ` — ${el.componentName}` : '';
        lines.push(`- \`${el.selector}\`${tid}${comp}`);
      }
    }

    if (a.kind === 'draw' && a.dataUrl.length > 0) {
      lines.push('', '(see attached image)');
    }
  });

  return lines.join('\n');
}

function dataUrlToBase64(
  dataUrl: string,
): { mediaType: ImageAttachment['source']['media_type']; data: string } | null {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(dataUrl);
  if (!m) return null;
  return {
    mediaType: m[1].toLowerCase() as ImageAttachment['source']['media_type'],
    data: m[2],
  };
}

export function extractImageAttachments(annotations: Annotation[]): ImageAttachment[] {
  const out: ImageAttachment[] = [];
  for (const a of annotations) {
    if (a.kind !== 'draw') continue;
    if (!a.dataUrl) continue;
    const parsed = dataUrlToBase64(a.dataUrl);
    if (!parsed) continue;
    out.push({
      type: 'image',
      source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
    });
  }
  return out;
}
