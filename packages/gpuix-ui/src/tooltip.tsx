import {
  Tooltip as GpuixTooltip,
  TooltipContent as GpuixTooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@gpuix/react/tooltip';
import type { TooltipContentProps, TooltipProps } from '@gpuix/react/tooltip';
import type { ReactElement } from 'react';

import { useGpuixUiTheme } from './theme';

export const Tooltip = GpuixTooltip;
export type { TooltipProps };
export { TooltipProvider, TooltipTrigger };

export function TooltipContent({
  style,
  sideOffset = 6,
  ...props
}: TooltipContentProps): ReactElement {
  const theme = useGpuixUiTheme();
  return (
    <GpuixTooltipContent
      {...props}
      sideOffset={sideOffset}
      style={{
        maxWidth: 320,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        backgroundColor: theme.colors.overlay,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radii.small,
        fontSize: theme.fontSizes.caption,
        boxShadow: {
          offsetX: 0,
          offsetY: 5,
          blurRadius: 16,
          spreadRadius: 0,
          color: '#00000066',
        },
        ...style,
      }}
    />
  );
}
