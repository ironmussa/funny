import { CircleCheck, Info, LoaderCircle, OctagonX, TriangleAlert } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  const sonnerTheme = resolvedTheme === 'monochrome' ? 'light' : 'dark';

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
            'group toast group-[.toaster]:!bg-background group-[.toaster]:!text-foreground group-[.toaster]:!border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:!text-muted-foreground',
          actionButton: 'group-[.toast]:!bg-primary group-[.toast]:!text-primary-foreground',
          cancelButton: 'group-[.toast]:!bg-muted group-[.toast]:!text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
