import type { AgentTemplate } from '@funny/shared';
import { Bot, Check, ChevronDown } from 'lucide-react';
import { memo, useState, type ComponentProps } from 'react';

import { ProviderSetupDialog } from '@/components/ProviderSetupDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';
import { getEffortLevels, parseUnifiedModel } from '@/lib/providers';

import { MobileModeSelect, MobileModelSelect, MobileTemplateSelect } from './MobilePromptSelectors';

// ── Selectors ────────────────────────────────────────────────────

const DesktopModeSelect = memo(function DesktopModeSelect({
  value,
  onChange,
  modes,
}: {
  value: string;
  onChange: (v: string) => void;
  modes: { value: string; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid="prompt-mode-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent side="top" align="start">
        {modes.map((m) => (
          <SelectItem key={m.value} value={m.value} size="xs">
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

export type ModelSelectGroup = {
  provider: string;
  providerLabel: string;
  models: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  disabledReason?: 'not-installed' | 'no-runner';
};

/**
 * Combined model + thinking-effort picker. Selecting a model that supports
 * reasoning effort opens a submenu of thinking modes; picking a mode sets the
 * model AND the effort in one action, and both are reflected in the trigger
 * copy (e.g. "Opus 4.8 · High"). Models without effort support are plain items.
 */
const DesktopModelSelect = memo(function DesktopModelSelect({
  value,
  effort,
  onChange,
  onEffortChange,
  groups,
  projectId,
}: {
  value: string;
  effort?: string;
  onChange: (v: string) => void;
  onEffortChange?: (v: string) => void;
  groups: ModelSelectGroup[];
  projectId?: string;
}) {
  const [setupProvider, setSetupProvider] = useState<ModelSelectGroup | null>(null);
  const selectedGroup = groups.find((g) => g.models.some((m) => m.value === value));
  const selected = selectedGroup?.models.find((m) => m.value === value);
  const { provider: selProvider, model: selModel } = parseUnifiedModel(value);
  const selEffortLabel = getEffortLevels(selModel, selProvider).find(
    (e) => e.value === effort,
  )?.label;

  // Leading slot keeps labels aligned whether or not a row shows a checkmark.
  const lead = (active: boolean) => (
    <span className="flex w-3 shrink-0 items-center justify-center">
      {active && <Check className="icon-2xs" />}
    </span>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="prompt-model-select"
          tabIndex={-1}
          className="text-foreground hover:bg-accent/50 focus-visible:ring-ring/50 flex h-7 w-auto cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs focus-visible:ring-1 focus-visible:outline-hidden"
        >
          <span className="text-muted-foreground shrink-0">
            {selectedGroup?.providerLabel ?? selProvider}
          </span>
          <span className="text-muted-foreground shrink-0">·</span>
          <span className="truncate">{selected?.label ?? selModel}</span>
          {selEffortLabel && <span className="text-muted-foreground">· {selEffortLabel}</span>}
          <ChevronDown className="icon-xs opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          collisionPadding={8}
          size="xs"
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 overflow-y-auto overscroll-contain"
        >
          {groups.map((group, idx) => (
            <DropdownMenuGroup key={group.provider}>
              {idx > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel
                className={group.disabled ? 'text-muted-foreground/60' : undefined}
                data-testid={group.disabled ? `model-group-disabled-${group.provider}` : undefined}
              >
                {group.providerLabel}
                {group.disabledReason === 'no-runner' && (
                  <span className="ml-1 font-normal italic">— connect a runner</span>
                )}
                {group.disabledReason === 'not-installed' && (
                  <span className="ml-1 font-normal italic">— not installed on runner</span>
                )}
              </DropdownMenuLabel>
              {group.disabledReason !== 'no-runner' && (
                <DropdownMenuItem size="xs" onSelect={() => setSetupProvider(group)}>
                  {group.disabledReason === 'not-installed'
                    ? 'Install / configure provider…'
                    : 'Configure provider…'}
                </DropdownMenuItem>
              )}
              {group.models.map((m) => {
                const isSelected = m.value === value;
                const { model: mModel } = parseUnifiedModel(m.value);
                const efforts = m.disabled ? [] : getEffortLevels(mModel, group.provider);

                if (efforts.length > 0 && onEffortChange) {
                  return (
                    <DropdownMenuSub key={m.value}>
                      <DropdownMenuSubTrigger
                        size="xs"
                        data-testid={`prompt-model-option-${m.value}`}
                      >
                        {lead(isSelected)}
                        <span className="truncate">{m.label}</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuPortal>
                        <DropdownMenuSubContent
                          size="xs"
                          collisionPadding={8}
                          className="max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto overscroll-contain"
                        >
                          {efforts.map((e) => (
                            <DropdownMenuItem
                              key={e.value}
                              size="xs"
                              data-testid={`prompt-effort-option-${m.value}-${e.value}`}
                              onSelect={() => {
                                onChange(m.value);
                                onEffortChange(e.value);
                              }}
                            >
                              {lead(isSelected && effort === e.value)}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span>{e.label}</span>
                                </TooltipTrigger>
                                <TooltipContent>{e.description}</TooltipContent>
                              </Tooltip>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuPortal>
                    </DropdownMenuSub>
                  );
                }

                return (
                  <DropdownMenuItem
                    key={m.value}
                    size="xs"
                    disabled={m.disabled}
                    data-testid={`prompt-model-option-${m.value}`}
                    onSelect={() => onChange(m.value)}
                  >
                    {lead(isSelected)}
                    <span className="truncate">{m.label}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {setupProvider && (
        <ProviderSetupDialog
          key={`${setupProvider.provider}:${projectId}`}
          provider={setupProvider.provider}
          label={setupProvider.providerLabel}
          projectId={projectId}
          onClose={() => setSetupProvider(null)}
        />
      )}
    </>
  );
});

const DesktopTemplateSelect = memo(function DesktopTemplateSelect({
  value,
  onChange,
  templates,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  templates: AgentTemplate[];
}) {
  const userTemplates = templates.filter((t) => !t.id.startsWith('__builtin__') && !t.shared);
  const sharedTemplates = templates.filter((t) => !t.id.startsWith('__builtin__') && t.shared);
  const builtinTemplates = templates.filter((t) => t.id.startsWith('__builtin__'));

  const renderItem = (tpl: AgentTemplate) => (
    <SelectItem key={tpl.id} value={tpl.id} size="xs">
      <span className="flex items-center gap-1.5">
        {tpl.color && (
          <span
            className="inline-block size-2 shrink-0 rounded-full"
            style={{ backgroundColor: tpl.color }}
          />
        )}
        <span className="truncate">{tpl.name}</span>
        {tpl.model && (
          <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-[9px]">
            {tpl.model}
          </span>
        )}
      </span>
      {tpl.description && (
        <span className="text-muted-foreground block truncate pl-3.5 text-[10px]">
          {tpl.description}
        </span>
      )}
    </SelectItem>
  );

  return (
    <Select
      value={value ?? '__none__'}
      onValueChange={(v) => onChange(v === '__none__' ? undefined : v)}
    >
      <SelectTrigger
        data-testid="prompt-template-select"
        tabIndex={-1}
        size="xs"
        className="w-auto border-none bg-transparent shadow-none"
      >
        <span className="flex items-center gap-1">
          <Bot className="icon-xs" />
          <SelectValue placeholder="Template" />
        </span>
      </SelectTrigger>
      <SelectContent side="top" align="start">
        <SelectItem value="__none__" size="xs">
          No template
        </SelectItem>
        {userTemplates.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-[10px]">My Templates</SelectLabel>
            {userTemplates.map(renderItem)}
          </SelectGroup>
        )}
        {sharedTemplates.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-[10px]">Shared</SelectLabel>
            {sharedTemplates.map(renderItem)}
          </SelectGroup>
        )}
        {builtinTemplates.length > 0 && (
          <SelectGroup>
            <SelectSeparator />
            <SelectLabel className="text-[10px]">Built-in</SelectLabel>
            {builtinTemplates.map(renderItem)}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  );
});

export const ModeSelect = memo(function ModeSelect(
  props: ComponentProps<typeof DesktopModeSelect>,
) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileModeSelect {...props} /> : <DesktopModeSelect {...props} />;
});
export const ModelSelect = memo(function ModelSelect(
  props: ComponentProps<typeof DesktopModelSelect>,
) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileModelSelect {...props} /> : <DesktopModelSelect {...props} />;
});
export const TemplateSelect = memo(function TemplateSelect(
  props: ComponentProps<typeof DesktopTemplateSelect>,
) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileTemplateSelect {...props} /> : <DesktopTemplateSelect {...props} />;
});
