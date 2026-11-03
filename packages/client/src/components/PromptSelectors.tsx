import type { AgentTemplate } from '@funny/shared';
import { Bot, Check, ChevronDown } from 'lucide-react';
import { memo, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderSetupDialog } from '@/components/ProviderSetupDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  disabledReason?: 'not-installed' | 'no-runner' | 'sandbox-unsupported';
};

/** Leading slot keeps labels aligned whether or not a row shows a checkmark. */
function SelectLead({ active }: { active: boolean }) {
  return (
    <span className="flex w-3 shrink-0 items-center justify-center">
      {active && <Check className="icon-2xs" />}
    </span>
  );
}

const DISABLED_REASON_SUFFIX: Record<NonNullable<ModelSelectGroup['disabledReason']>, string> = {
  'no-runner': '— connect a runner',
  'not-installed': '— not installed on runner',
  'sandbox-unsupported': '— not available in sandboxes yet',
};

/** Groups whose provider can be installed/configured from the picker. */
function canConfigureProvider(group: ModelSelectGroup): boolean {
  return group.disabledReason !== 'no-runner' && group.disabledReason !== 'sandbox-unsupported';
}

type ModelOptionProps = {
  model: ModelSelectGroup['models'][number];
  provider: string;
  value: string;
  effort?: string;
  onChange: (v: string) => void;
  onEffortChange?: (v: string) => void;
};

function ModelEffortSubmenu({
  model: m,
  efforts,
  isSelected,
  effort,
  onChange,
  onEffortChange,
}: {
  model: ModelSelectGroup['models'][number];
  efforts: ReturnType<typeof getEffortLevels>;
  isSelected: boolean;
  effort?: string;
  onChange: (v: string) => void;
  onEffortChange: (v: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger size="xs" data-testid={`prompt-model-option-${m.value}`}>
        <SelectLead active={isSelected} />
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
              <SelectLead active={isSelected && effort === e.value} />
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

function ModelOption({
  model: m,
  provider,
  value,
  effort,
  onChange,
  onEffortChange,
}: ModelOptionProps) {
  const isSelected = m.value === value;
  const { model: mModel } = parseUnifiedModel(m.value);
  const efforts = m.disabled ? [] : getEffortLevels(mModel, provider);

  if (efforts.length > 0 && onEffortChange) {
    return (
      <ModelEffortSubmenu
        model={m}
        efforts={efforts}
        isSelected={isSelected}
        effort={effort}
        onChange={onChange}
        onEffortChange={onEffortChange}
      />
    );
  }

  return (
    <DropdownMenuItem
      size="xs"
      disabled={m.disabled}
      data-testid={`prompt-model-option-${m.value}`}
      onSelect={() => onChange(m.value)}
    >
      <SelectLead active={isSelected} />
      <span className="truncate">{m.label}</span>
    </DropdownMenuItem>
  );
}

function ModelGroupSection({
  group,
  onSetup,
  ...optionProps
}: Omit<ModelOptionProps, 'model' | 'provider'> & {
  group: ModelSelectGroup;
  onSetup: (group: ModelSelectGroup) => void;
}) {
  const suffix = group.disabledReason ? DISABLED_REASON_SUFFIX[group.disabledReason] : null;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        size="xs"
        data-testid={`prompt-provider-option-${group.provider}`}
        disabled={group.disabled && !canConfigureProvider(group)}
      >
        <SelectLead active={group.models.some((model) => model.value === optionProps.value)} />
        <span>{group.providerLabel}</span>
        {suffix && <span className="text-muted-foreground ml-1 font-normal italic">{suffix}</span>}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          size="xs"
          collisionPadding={8}
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 overflow-y-auto overscroll-contain"
        >
          {canConfigureProvider(group) && (
            <>
              <DropdownMenuItem size="xs" onSelect={() => onSetup(group)}>
                {group.disabledReason === 'not-installed'
                  ? 'Install / configure provider…'
                  : 'Configure provider…'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {group.models.map((m) => (
            <ModelOption
              key={m.value}
              model={group.disabled ? { ...m, disabled: true } : m}
              provider={group.provider}
              {...optionProps}
            />
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/**
 * Cascading provider → model → thinking-effort picker. Selecting a model that supports
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
  const { t } = useTranslation();
  const [setupProvider, setSetupProvider] = useState<ModelSelectGroup | null>(null);
  const selectedGroup =
    groups.find((g) => g.models.some((m) => m.value === value)) ??
    groups.find((g) => g.provider === parseUnifiedModel(value).provider);
  const selected = selectedGroup?.models.find((m) => m.value === value);
  const { provider: selProvider, model: selModel } = parseUnifiedModel(value);
  const selEffortLabel = getEffortLevels(selModel, selProvider).find(
    (e) => e.value === effort,
  )?.label;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="prompt-model-select"
          aria-label={t('prompt.mobileSelectors.model', 'Model')}
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
          {groups.map((group) => (
            <ModelGroupSection
              key={group.provider}
              group={group}
              value={value}
              effort={effort}
              onChange={onChange}
              onEffortChange={onEffortChange}
              onSetup={setSetupProvider}
            />
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
