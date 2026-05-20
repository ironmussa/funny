type TextNode = { type: 'text'; value: string };
type ElementNode = {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: NodeContent[];
};
type NodeContent = TextNode | ElementNode | { type: string; [key: string]: unknown };
type RootNode = { type: 'root'; children: NodeContent[] };

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

  return (tree: RootNode) => {
    if (!query) return;
    const lowerQuery = query.toLowerCase();
    const queryLen = query.length;

    function transformChildren(children: NodeContent[]): NodeContent[] {
      const out: NodeContent[] = [];
      for (const child of children) {
        if (child.type === 'element') {
          const element = child as ElementNode;
          const tag = element.tagName;
          if (tag === 'code' || tag === 'pre') {
            out.push(child);
            continue;
          }
          element.children = transformChildren(element.children);
          out.push(element);
        } else if (child.type === 'text') {
          out.push(...splitTextNode(child as TextNode));
        } else {
          out.push(child);
        }
      }
      return out;
    }

    function splitTextNode(node: TextNode): NodeContent[] {
      const text = node.value;
      const lower = text.toLowerCase();
      if (!lower.includes(lowerQuery)) return [node];

      const parts: NodeContent[] = [];
      let last = 0;
      let idx = lower.indexOf(lowerQuery);
      while (idx !== -1) {
        if (idx > last) {
          parts.push({ type: 'text', value: text.slice(last, idx) });
        }
        const mark: ElementNode = {
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

    tree.children = transformChildren(tree.children);
  };
}
