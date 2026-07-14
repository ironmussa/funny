import { useTranslation } from 'react-i18next';

interface ViewAllButtonProps {
  onClick: () => void;
  'data-testid'?: string;
}

export function ViewAllButton({ onClick, ...props }: ViewAllButtonProps) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="text-muted-foreground/60 hover:text-foreground focus-visible:ring-sidebar-ring flex w-full cursor-pointer items-center rounded-md bg-transparent py-1.5 pl-7 text-left text-sm transition-colors focus:outline-hidden focus-visible:ring-1 focus-visible:ring-inset"
      {...props}
    >
      {t('sidebar.viewAll')}
    </button>
  );
}
