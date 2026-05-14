import { setCustomNativeDragPreview } from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';

interface DashedPreviewArgs {
  nativeSetDragImage: ((image: Element, x: number, y: number) => void) | null;
  source: HTMLElement;
}

export function setDashedDragPreview({ nativeSetDragImage, source }: DashedPreviewArgs) {
  setCustomNativeDragPreview({
    nativeSetDragImage,
    getOffset: () => ({ x: 16, y: 16 }),
    render: ({ container }) => {
      const rect = source.getBoundingClientRect();
      const styles = getComputedStyle(source);
      const primary = styles.getPropertyValue('--primary').trim() || '240 5.9% 10%';
      const background = styles.getPropertyValue('--background').trim() || '0 0% 100%';
      const preview = document.createElement('div');
      preview.style.cssText = [
        `width:${Math.max(rect.width, 80)}px`,
        `height:${Math.max(rect.height, 40)}px`,
        'border-radius:8px',
        `border:2px dashed hsl(${primary})`,
        `background:hsl(${background})`,
        `box-shadow:0 4px 12px hsl(${primary} / 0.25)`,
      ].join(';');
      container.appendChild(preview);
    },
  });
}
