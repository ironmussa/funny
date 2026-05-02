import type { Element, ElementContent, Root, Text } from 'hast';

export interface RehypeMarkSearchOptions {
  query: string;
  matchClass?: string;
}

/**
 * Rehype plugin that wraps case-insensitive matches of `query` inside text nodes
 * with a `<mark>` element. Skips text inside `<code>` and `<pre>` blocks where
 * highlighting would corrupt syntax-rendered content.
 */
export function rehypeMarkSearch(options: RehypeMarkSearchOptions = { query: '' }) {
  const query = options.query.trim();
  const matchClass = options.matchClass ?? 'md-search-match';

  return (tree: Root) => {
    if (!query) return;
    const lowerQuery = query.toLowerCase();
    const queryLen = query.length;

    function transformChildren(children: ElementContent[]): ElementContent[] {
      const out: ElementContent[] = [];
      for (const child of children) {
        if (child.type === 'element') {
          const tag = child.tagName;
          if (tag === 'code' || tag === 'pre') {
            out.push(child);
            continue;
          }
          child.children = transformChildren(child.children);
          out.push(child);
        } else if (child.type === 'text') {
          out.push(...splitTextNode(child));
        } else {
          out.push(child);
        }
      }
      return out;
    }

    function splitTextNode(node: Text): ElementContent[] {
      const text = node.value;
      const lower = text.toLowerCase();
      if (!lower.includes(lowerQuery)) return [node];

      const parts: ElementContent[] = [];
      let last = 0;
      let idx = lower.indexOf(lowerQuery);
      while (idx !== -1) {
        if (idx > last) {
          parts.push({ type: 'text', value: text.slice(last, idx) });
        }
        const mark: Element = {
          type: 'element',
          tagName: 'mark',
          properties: { className: [matchClass] },
          children: [{ type: 'text', value: text.slice(idx, idx + queryLen) }],
        };
        parts.push(mark);
        last = idx + queryLen;
        idx = lower.indexOf(lowerQuery, last);
      }
      if (last < text.length) {
        parts.push({ type: 'text', value: text.slice(last) });
      }
      return parts;
    }

    tree.children = transformChildren(tree.children as ElementContent[]) as Root['children'];
  };
}
