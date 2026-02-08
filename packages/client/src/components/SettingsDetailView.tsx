import { useAppStore } from '@/stores/app-store';
import { useSettingsStore, editorLabels, type Theme, type Editor } from '@/stores/settings-store';
import { settingsItems, type SettingsItemId } from './SettingsPanel';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sun, Moon, Monitor } from 'lucide-react';
import { McpServerSettings } from './McpServerSettings';
import { SkillsSettings } from './SkillsSettings';

/* ── Reusable setting row ── */
function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 border-b border-border/50 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

/* ── Segmented control (for theme) ── */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-sm transition-colors',
            value === opt.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── General settings content ── */
function GeneralSettings() {
  const { theme, defaultEditor, setTheme, setDefaultEditor } = useSettingsStore();

  return (
    <>
      {/* General section */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
        General
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden mb-6">
        <SettingRow
          title="Default open destination"
          description="Where files and folders open by default"
        >
          <Select value={defaultEditor} onValueChange={(v) => setDefaultEditor(v as Editor)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(editorLabels) as [Editor, string][]).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      {/* Appearance section */}
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-2">
        Appearance
      </h3>
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <SettingRow
          title="Theme"
          description="Use light, dark, or match your system"
        >
          <SegmentedControl<Theme>
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light', icon: <Sun className="h-3 w-3" /> },
              { value: 'dark', label: 'Dark', icon: <Moon className="h-3 w-3" /> },
              { value: 'system', label: 'System', icon: <Monitor className="h-3 w-3" /> },
            ]}
          />
        </SettingRow>
      </div>
    </>
  );
}

export function SettingsDetailView() {
  const { activeSettingsPage } = useAppStore();
  const page = activeSettingsPage as SettingsItemId | null;
  const label = page ? settingsItems.find((i) => i.id === page)?.label : null;

  if (!page) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        Select a setting from the sidebar
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full">
      {/* Page header */}
      <div className="px-8 pt-8 pb-4">
        <h2 className="text-lg font-semibold tracking-tight">{label}</h2>
      </div>

      {/* Page content */}
      <ScrollArea className="flex-1">
        <div className="px-8 pb-8 max-w-2xl">
          {page === 'general' ? (
            <GeneralSettings />
          ) : page === 'mcp-server' ? (
            <McpServerSettings />
          ) : page === 'skills' ? (
            <SkillsSettings />
          ) : (
            <p className="text-sm text-muted-foreground">
              {label} settings coming soon.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
