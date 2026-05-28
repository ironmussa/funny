import { describe, expect, it } from 'vitest';

import {
  getMermaidInitOptions,
  getSvgExportDimensions,
  inlineForeignObjects,
  removeMermaidRenderArtifacts,
  sanitizeMermaidSvg,
} from './mermaid-utils';

const SVG_NS = 'http://www.w3.org/2000/svg';

function parseSvg(svg: string): SVGSVGElement {
  // Use the HTML parser path so the test matches what sanitizeMermaidSvg does
  // on real mermaid output (HTML-parsed, since mermaid embeds the SVG into the
  // page DOM and the sanitizer reads template.innerHTML).
  const tmpl = document.createElement('template');
  tmpl.innerHTML = svg;
  const el = tmpl.content.querySelector('svg');
  if (!el) throw new Error('test fixture has no <svg>');
  return el as unknown as SVGSVGElement;
}

describe('sanitizeMermaidSvg', () => {
  it('returns the input untouched when empty', () => {
    expect(sanitizeMermaidSvg('')).toBe('');
  });

  it('strips <script> tags injected into the SVG', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>',
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).toMatch(/<rect/);
  });

  it('strips inline event handlers (on*) from any element', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="boom()" onmouseover="x()" fill="red"/></svg>',
    );
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/onmouseover/i);
    // Defense-in-depth must not destroy legitimate attributes.
    expect(out).toMatch(/fill="red"/);
  });

  it('removes href / xlink:href / src values that point at javascript: URLs', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<a href="javascript:steal()"><text>x</text></a>' +
        '<image xlink:href="JAVASCRIPT:explode()"/>' +
        '<image src="javascript:boom()"/>' +
        '</svg>',
    );
    expect(out).not.toMatch(/javascript:/i);
  });

  it('preserves a regular href and the surrounding element', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><text>x</text></a></svg>',
    );
    expect(out).toMatch(/href="https:\/\/example\.com"/);
  });

  it('preserves <foreignObject> content — that was the DOMPurify regression we replaced', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<foreignObject x="0" y="0" width="100" height="40">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">node label</div>' +
        '</foreignObject>' +
        '</svg>',
    );
    expect(out).toMatch(/<foreignobject|<foreignObject/i);
    expect(out).toContain('node label');
  });

  it('returns an empty string when no <svg> is present', () => {
    expect(sanitizeMermaidSvg('<div>not an svg</div>')).toBe('');
  });
});

describe('inlineForeignObjects', () => {
  function makeSvg(inner: string): SVGSVGElement {
    return parseSvg(`<svg xmlns="${SVG_NS}" viewBox="0 0 200 100">${inner}</svg>`);
  }

  it('is a no-op when there are no foreignObject elements', () => {
    const svg = makeSvg('<rect width="10" height="10"/>');
    const before = svg.innerHTML;
    inlineForeignObjects(svg);
    expect(svg.innerHTML).toBe(before);
  });

  it('replaces a foreignObject with a <text> centered on its rect', () => {
    const svg = makeSvg(
      '<foreignObject x="10" y="20" width="100" height="40">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">hello</div>' +
        '</foreignObject>',
    );
    inlineForeignObjects(svg);

    // foreignObject is gone.
    expect(svg.querySelector('foreignObject')).toBeNull();

    const text = svg.querySelector('text');
    expect(text).not.toBeNull();
    // Centered on (x + w/2, y + h/2) = (60, 40).
    expect(text!.getAttribute('x')).toBe('60');
    expect(text!.getAttribute('y')).toBe('40');
    expect(text!.getAttribute('text-anchor')).toBe('middle');
    expect(text!.getAttribute('dominant-baseline')).toBe('middle');
    expect(text!.textContent).toBe('hello');
  });

  it('flattens multi-line HTML labels into a single whitespace-collapsed string', () => {
    // Mermaid sometimes emits multi-line labels with <br/> or nested spans.
    // The export path doesn't try to reproduce line layout — it just wants
    // readable text in the PNG, so we collapse whitespace.
    const svg = makeSvg(
      '<foreignObject x="0" y="0" width="80" height="40">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">' +
        '<span>line one</span><br/><span>line two</span>' +
        '</div>' +
        '</foreignObject>',
    );
    inlineForeignObjects(svg);
    const text = svg.querySelector('text');
    expect(text!.textContent).toBe('line one line two');
  });

  it('converts every foreignObject when there are several siblings', () => {
    const svg = makeSvg(
      '<foreignObject x="0" y="0" width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">a</div></foreignObject>' +
        '<foreignObject x="20" y="0" width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">b</div></foreignObject>' +
        '<foreignObject x="40" y="0" width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">c</div></foreignObject>',
    );
    inlineForeignObjects(svg);
    expect(svg.querySelectorAll('foreignObject')).toHaveLength(0);
    const labels = Array.from(svg.querySelectorAll('text')).map((t) => t.textContent);
    expect(labels).toEqual(['a', 'b', 'c']);
  });
});

describe('getSvgExportDimensions', () => {
  function svgWith(attrs: Record<string, string>): SVGSVGElement {
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return parseSvg(`<svg xmlns="${SVG_NS}" ${attrStr}/>`);
  }

  it('uses the viewBox when present, even if width/height are also set', () => {
    const svg = svgWith({ viewBox: '0 0 1234 567', width: '999', height: '111' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 1234, h: 567 });
  });

  it('uses the viewBox when width/height are responsive percentages (the original bug)', () => {
    // Repro for the "tall narrow strip" export. parseFloat("100%") === 100 was
    // producing a 100px-wide canvas while the height came from a real viewBox
    // dimension, ruining the aspect ratio. viewBox must win.
    const svg = svgWith({ viewBox: '0 0 800 200', width: '100%', height: '100%' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 800, h: 200 });
  });

  it('parses comma-separated viewBox values (SVG allows both spaces and commas)', () => {
    const svg = svgWith({ viewBox: '0,0,300,150' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 300, h: 150 });
  });

  it('falls back to absolute width/height when no viewBox is set', () => {
    const svg = svgWith({ width: '640', height: '480' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 640, h: 480 });
  });

  it('ignores percentage width/height in the fallback path', () => {
    // No viewBox AND width is a percentage — we should NOT trust the percentage
    // as a pixel count. Default to the safe 800×600.
    const svg = svgWith({ width: '100%', height: '50%' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 800, h: 600 });
  });

  it('falls back to 800×600 when nothing useful is present', () => {
    const svg = svgWith({});
    expect(getSvgExportDimensions(svg)).toEqual({ w: 800, h: 600 });
  });

  it('rejects malformed viewBox (wrong arity or NaN) and falls back', () => {
    // 3-value viewBox is invalid — should not be trusted, even partially.
    const svg = svgWith({ viewBox: '0 0 100', width: '321', height: '123' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 321, h: 123 });
  });

  it('rejects a viewBox with negative dimensions', () => {
    const svg = svgWith({ viewBox: '0 0 -100 -50', width: '321', height: '123' });
    expect(getSvgExportDimensions(svg)).toEqual({ w: 321, h: 123 });
  });
});

describe('getMermaidInitOptions', () => {
  it('suppresses built-in error SVG injection into document.body', () => {
    expect(getMermaidInitOptions('dark').suppressErrorRendering).toBe(true);
  });
});

describe('removeMermaidRenderArtifacts', () => {
  it('removes mermaid temp nodes by id prefix', () => {
    const renderId = 'mermaid-test-abc';
    for (const id of [renderId, `d${renderId}`, `i${renderId}`]) {
      const el = document.createElement('div');
      el.id = id;
      document.body.appendChild(el);
    }
    removeMermaidRenderArtifacts(renderId);
    expect(document.getElementById(renderId)).toBeNull();
    expect(document.getElementById(`d${renderId}`)).toBeNull();
    expect(document.getElementById(`i${renderId}`)).toBeNull();
  });
});
