/** Data shapes of the annotator content script. */

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementData {
  element: string;
  elementPath: string;
  elementName: string;
  x: number;
  y: number;
  boundingBox: BoundingBox;
  componentTree: string;
  cssClasses: string;
  computedStyles: string;
  accessibility: string;
  nearbyText: string;
  isFixed: boolean;
  fullPath: string;
  nearbyElements: string;
  outerHTML: string;
  domElement: Element; // private ref, not serialized
}

export interface Annotation {
  id: string;
  prompt: string;
  timestamp: number;
  url: string;
  selectedText: string;
  status: string;
  elements: ElementData[];
}

export interface AnnotationOverlay {
  hl: HTMLDivElement;
  badge: HTMLDivElement;
  element: Element;
}

// ---------------------------------------------------------------------------
// Annotation history
// ---------------------------------------------------------------------------
/** An entry of `funnyHistory` in chrome.storage.local, written only by saveToHistory. */
export interface HistoryEntry {
  id: string;
  timestamp: number;
  url: string;
  title: string;
  threadId: string | null;
  projectId: string | null;
  annotationCount: number;
  annotations: any[];
  serverUrl?: string;
}

export interface FunnyHistoryStorage {
  funnyHistory?: HistoryEntry[];
}
