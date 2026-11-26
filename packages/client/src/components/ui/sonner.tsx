import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Toaster as Sonner } from 'sonner';

import { isLightTheme } from '@/lib/theme';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  const sonnerTheme = isLightTheme(resolvedTheme) ? 'light' : 'dark';

  return (
    <Sonner
      theme={sonnerTheme}
      className="toaster group"
      visibleToasts={5}
      icons={{
        success: <CircleCheck className="icon-base" />,
        info: <Info className="icon-base" />,
        warning: <TriangleAlert className="icon-base" />,
        error: <OctagonX className="icon-base" />,
        loading: <LoaderCircle className="icon-base animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background! group-[.toaster]:text-foreground! group-[.toaster]:border-border! group-[.toaster]:shadow-lg',
          // Every toast gets the same bound: a long message (a git hook's
          // whole output, say) is cut at a few lines instead of filling the
          // screen, and a long word (a path, a URL) wraps instead of overflowing.
          title: 'line-clamp-4 break-words',
          description: 'group-[.toast]:text-muted-foreground! line-clamp-4 break-words',
          actionButton: 'group-[.toast]:bg-primary! group-[.toast]:text-primary-foreground!',
          cancelButton: 'group-[.toast]:bg-muted! group-[.toast]:text-muted-foreground!',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
