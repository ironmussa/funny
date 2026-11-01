import { createPortal } from '@gpuix/react';
import type { PublicInstance } from '@gpuix/react';
import { createContext, use, useState } from 'react';
import type { ReactNode } from 'react';

const PointerCaptureLayerContext = createContext<PublicInstance | null>(null);

/**
 * Hosts drag-capture overlays above the whole app. Render it as the content of the root
 * element: overlays sent through `PointerCapture` then cover every panel, so a drag keeps
 * receiving moves when the pointer crosses into another panel.
 */
export function PointerCaptureScope({ children }: { children: ReactNode }): ReactNode {
  const [layer, setLayer] = useState<PublicInstance | null>(null);
  return (
    <>
      <PointerCaptureLayerContext value={layer}>{children}</PointerCaptureLayerContext>
      <div
        ref={setLayer}
        testId="pointer-capture-layer"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          pointerEvents: 'none',
        }}
      />
    </>
  );
}

/** Renders a capture overlay in the nearest `PointerCaptureScope`, or in place without one. */
export function PointerCapture({ children }: { children: ReactNode }): ReactNode {
  const layer = use(PointerCaptureLayerContext);
  return layer ? createPortal(children, layer) : children;
}
