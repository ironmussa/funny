import type { ProviderInfo } from '../api';
import type { Annotation, AnnotationOverlay } from './types';

/**
 * Mutable state of the annotator content script, shared by its modules.
 * DOM refs are created once by `createShadowHost` and reused.
 */
class ContentState {
  isActive = false;
  annotations: Annotation[] = [];
  hoveredElement: Element | null = null;
  isPaused = false;
  isBrowsing = false;
  annotationsVisible = true;
  isDragging = false;
  dragOffset = { x: 0, y: 0 };
  scrollRafId: number | null = null;
  runtimeDisconnected = false;
  // Drawing mode state
  isDrawing = false;
  isDrawingStroke = false;
  drawingCanvas!: HTMLCanvasElement;
  drawingCtx!: CanvasRenderingContext2D;
  hasDrawingContent = false;
  drawColor = '#ef4444';
  drawToolbar!: HTMLDivElement;
  drawPromptInput!: HTMLTextAreaElement;
  // Test ID label overlay state
  testIdLabelsVisible = false;
  testIdContainer!: HTMLDivElement;
  testIdObserver: MutationObserver | null = null;
  testIdScrollHandler: (() => void) | null = null;
  // Multi-select state (Ctrl+click)
  multiSelectElements: Element[] = [];
  multiSelectOverlays: AnnotationOverlay[] = [];
  pendingMultiSelectElements: Element[] | null = null;
  multiSelectContainer!: HTMLDivElement;
  // DOM refs (created once, reused)
  shadowHost!: HTMLDivElement;
  shadowRoot!: ShadowRoot;
  toolbarEl!: HTMLDivElement;
  hoverHighlight!: HTMLDivElement;
  hoverLabel!: HTMLDivElement;
  popover!: HTMLDivElement;
  settingsPanel!: HTMLDivElement;
  historyPanel!: HTMLDivElement;
  badgeContainer!: HTMLDivElement;
  highlightContainer!: HTMLDivElement;
  // Cached popover element refs (set after createPopover)
  popoverTextarea!: HTMLTextAreaElement;
  popoverError!: HTMLDivElement;
  popoverElementName!: HTMLSpanElement;
  popoverElementList!: HTMLDivElement;
  popoverAddBtn!: HTMLButtonElement;
  popoverDeleteBtn!: HTMLButtonElement;
  popoverProjectName!: HTMLSpanElement;
  popoverSendBtn!: HTMLButtonElement;
  // Drag listener refs (for cleanup)
  dragMoveHandler: ((e: MouseEvent) => void) | null = null;
  dragUpHandler: (() => void) | null = null;
  // Stored DOM refs for annotation overlays (avoid recreating on scroll)
  annotationOverlays: AnnotationOverlay[] = [];
  pendingAnnotationElement: Element | null = null;
  editingAnnotationIndex = -1;
  // Cached provider data for the settings panel
  // (`models`: a plain model id list, read as a fallback for `modelsWithLabels`).
  settingsProviderData: Record<string, ProviderInfo & { models?: string[] }> | null = null;
  // Cached projects data (includes per-project defaults)
  settingsProjectsData: Array<{
    id: string;
    name: string;
    defaultProvider?: string;
    defaultModel?: string;
    defaultMode?: string;
  }> = [];
}

export const st = new ContentState();
