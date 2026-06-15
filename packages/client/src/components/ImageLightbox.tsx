import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useState, useCallback, useEffect, useEffectEvent } from 'react';
import { createPortal } from 'react-dom';

import { ImageZoomControls } from '@/components/ImageZoomControls';
import { BUTTON_ZOOM_FACTOR, useImageZoomPan } from '@/hooks/use-image-zoom-pan';
import { cn } from '@/lib/utils';

interface LightboxImage {
  src: string;
  alt: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
}

export function ImageLightbox({ images, initialIndex = 0, open, onClose }: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [lastOpenKey, setLastOpenKey] = useState(open ? `${initialIndex}` : null);
  const zoom = useImageZoomPan();

  // Reset the index AND the zoom/pan whenever the dialog (re-)opens or
  // initialIndex changes.
  const openKey = open ? `${initialIndex}` : null;
  if (openKey !== lastOpenKey) {
    setLastOpenKey(openKey);
    if (open) {
      setCurrentIndex(initialIndex);
      zoom.reset();
    }
  }

  const goNext = useCallback(() => {
    setCurrentIndex((i) => (i + 1) % images.length);
    zoom.reset();
  }, [images.length, zoom]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => (i - 1 + images.length) % images.length);
    zoom.reset();
  }, [images.length, zoom]);

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowRight') goNext();
    if (e.key === 'ArrowLeft') goPrev();
    if (e.key === '+' || e.key === '=') zoom.zoomBy(BUTTON_ZOOM_FACTOR);
    if (e.key === '-' || e.key === '_') zoom.zoomBy(1 / BUTTON_ZOOM_FACTOR);
    if (e.key === '0') zoom.reset();
  });

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open || images.length === 0) return null;

  const current = images[currentIndex];

  return createPortal(
    <div
      className="animate-in fade-in-0 fixed inset-0 z-100 flex items-center justify-center bg-black/80 duration-200"
      onClick={onClose}
      data-testid="image-lightbox"
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
        data-testid="lightbox-close"
      >
        <X className="icon-lg" />
      </button>

      {/* Previous button */}
      {images.length > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          className="absolute left-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          data-testid="lightbox-prev"
        >
          <ChevronLeft className="icon-xl" />
        </button>
      )}

      {/* Image */}
      <img
        {...zoom.imgProps}
        src={current.src}
        alt={current.alt}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl select-none',
          zoom.zoomed ? (zoom.dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in',
          zoom.dragging ? '' : 'transition-transform duration-150',
        )}
        data-testid="lightbox-image"
      />

      {/* Next button */}
      {images.length > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          className="absolute right-4 z-10 rounded-full bg-black/50 p-2 text-white transition-colors hover:bg-black/70"
          data-testid="lightbox-next"
        >
          <ChevronRight className="icon-xl" />
        </button>
      )}

      {/* Zoom controls */}
      <ImageZoomControls zoom={zoom} className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2" />

      {/* Counter */}
      {images.length > 1 && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm text-white">
          {currentIndex + 1} / {images.length}
        </div>
      )}
    </div>,
    document.body,
  );
}
