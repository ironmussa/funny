import type React from 'react';

export function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="min-w-0">
        <p className="settings-row-title">{title}</p>
        <p className="settings-row-desc">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
