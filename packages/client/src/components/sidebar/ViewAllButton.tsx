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
      className="py-1.5 pl-7 text-sm text-muted-foreground/60 transition-colors hover:text-foreground"
      {...props}
    >
      {t('sidebar.viewAll')}
    </button>
  );
}
