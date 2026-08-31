export interface ProductAutomationTreeNode {
  testId?: string;
  bounds?: { y: number; height: number };
  children?: ProductAutomationTreeNode[];
}

export interface ProductRowCounts {
  transcript: { retained: number; visible: number | null };
  fileTree: { retained: number; visible: number | null };
}

function isVisible(node: ProductAutomationTreeNode, viewportHeight: number): boolean {
  return Boolean(
    node.bounds && node.bounds.y + node.bounds.height >= 0 && node.bounds.y <= viewportHeight,
  );
}

export function countProductRows(
  tree: ProductAutomationTreeNode | null,
  viewportHeight: number,
): ProductRowCounts {
  const counts = {
    transcript: { retained: 0, visible: 0 },
    fileTree: { retained: 0, visible: 0 },
  };
  const visit = (node: ProductAutomationTreeNode) => {
    const target = node.testId?.startsWith('message-')
      ? counts.transcript
      : node.testId?.startsWith('file-tree-file-') || node.testId?.startsWith('file-tree-folder-')
        ? counts.fileTree
        : null;
    if (target) {
      target.retained += 1;
      if (isVisible(node, viewportHeight)) target.visible += 1;
    }
    node.children?.forEach(visit);
  };
  if (tree) visit(tree);
  return {
    transcript: {
      retained: counts.transcript.retained,
      visible: counts.transcript.visible || null,
    },
    fileTree: {
      retained: counts.fileTree.retained,
      visible: counts.fileTree.visible || null,
    },
  };
}
