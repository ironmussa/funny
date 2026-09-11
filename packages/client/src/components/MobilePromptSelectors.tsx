import type { AgentTemplate } from '@funny/shared';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ProviderSetupDialog } from '@/components/ProviderSetupDialog';
import { getEffortLevels, parseUnifiedModel } from '@/lib/providers';

import {
  PromptSelectionDrawer,
  PromptSelectionOption,
  PromptSelectionTrigger,
} from './PromptSelectionDrawer';
import type { ModelSelectGroup } from './PromptSelectors';

export function MobileModeSelect({
  value,
  onChange,
  modes,
}: {
  value: string;
  onChange: (value: string) => void;
  modes: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <PromptSelectionDrawer
      title={t('prompt.mobileSelectors.mode', 'Mode')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <PromptSelectionTrigger data-testid="prompt-mode-select">
          {modes.find((mode) => mode.value === value)?.label ?? value}
        </PromptSelectionTrigger>
      }
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
        {modes.map((mode) => (
          <PromptSelectionOption
            key={mode.value}
            selected={mode.value === value}
            onClick={() => {
              onChange(mode.value);
              setOpen(false);
            }}
          >
            {mode.label}
          </PromptSelectionOption>
        ))}
      </div>
    </PromptSelectionDrawer>
  );
}

export function MobileTemplateSelect({
  value,
  onChange,
  templates,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  templates: AgentTemplate[];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groups = [
    {
      label: t('prompt.mobileSelectors.myTemplates', 'My templates'),
      items: templates.filter((tpl) => !tpl.id.startsWith('__builtin__') && !tpl.shared),
    },
    {
      label: t('prompt.mobileSelectors.shared', 'Shared'),
      items: templates.filter((tpl) => !tpl.id.startsWith('__builtin__') && tpl.shared),
    },
    {
      label: t('prompt.mobileSelectors.builtIn', 'Built-in'),
      items: templates.filter((tpl) => tpl.id.startsWith('__builtin__')),
    },
  ];
  const select = (next: string | undefined) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <PromptSelectionDrawer
      title={t('prompt.mobileSelectors.template', 'Template')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <PromptSelectionTrigger data-testid="prompt-template-select">
          {templates.find((tpl) => tpl.id === value)?.name ??
            t('prompt.mobileSelectors.noTemplate', 'No template')}
        </PromptSelectionTrigger>
      }
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
        <PromptSelectionOption selected={!value} onClick={() => select(undefined)}>
          {t('prompt.mobileSelectors.noTemplate', 'No template')}
        </PromptSelectionOption>
        {groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="text-muted-foreground px-4 py-2 text-sm font-semibold">
                {group.label}
              </h3>
              {group.items.map((tpl) => (
                <PromptSelectionOption
                  key={tpl.id}
                  selected={tpl.id === value}
                  onClick={() => select(tpl.id)}
                >
                  <span className="flex items-center gap-2">
                    {tpl.color && (
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: tpl.color }}
                      />
                    )}
                    {tpl.name}
                  </span>
                  {tpl.model && (
                    <span className="text-muted-foreground block text-sm">{tpl.model}</span>
                  )}
                  {tpl.description && (
                    <span className="text-muted-foreground block text-sm">{tpl.description}</span>
                  )}
                </PromptSelectionOption>
              ))}
            </section>
          ))}
      </div>
    </PromptSelectionDrawer>
  );
}

export function MobileModelSelect({
  value,
  effort,
  onChange,
  onEffortChange,
  groups,
  projectId,
}: {
  value: string;
  effort?: string;
  onChange: (value: string) => void;
  onEffortChange?: (value: string) => void;
  groups: ModelSelectGroup[];
  projectId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [setupProvider, setSetupProvider] = useState<ModelSelectGroup | null>(null);
  const selectedGroup = groups.find((group) => group.models.some((model) => model.value === value));
  const selected = selectedGroup?.models.find((model) => model.value === value);
  const parsed = parseUnifiedModel(value);
  const effortLabel = getEffortLevels(parsed.model, parsed.provider).find(
    (item) => item.value === effort,
  )?.label;
  const pendingGroup = groups.find((group) =>
    group.models.some((model) => model.value === pendingModel),
  );
  const pending = pendingGroup?.models.find((model) => model.value === pendingModel);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setPendingModel(null);
  };
  return (
    <>
      <PromptSelectionDrawer
        title={
          pending
            ? `${pending.label} · ${t('prompt.mobileSelectors.effort', 'Thinking effort')}`
            : t('prompt.mobileSelectors.model', 'Model')
        }
        open={open}
        onOpenChange={changeOpen}
        trigger={
          <PromptSelectionTrigger data-testid="prompt-model-select">
            {selectedGroup?.providerLabel ?? parsed.provider} · {selected?.label ?? parsed.model}
            {effortLabel ? ` · ${effortLabel}` : ''}
          </PromptSelectionTrigger>
        }
      >
        <div className="min-h-0 overflow-y-auto overscroll-contain p-2">
          {pending && pendingGroup ? (
            <>
              <PromptSelectionOption onClick={() => setPendingModel(null)}>
                <span className="flex items-center gap-2">
                  <ArrowLeft className="size-4" />
                  {t('prompt.mobileSelectors.back', 'Back')}
                </span>
              </PromptSelectionOption>
              {getEffortLevels(parseUnifiedModel(pending.value).model, pendingGroup.provider).map(
                (item) => (
                  <PromptSelectionOption
                    key={item.value}
                    disabled={pending.disabled || pendingGroup.disabled}
                    selected={pending.value === value && item.value === effort}
                    data-testid={`prompt-effort-option-${pending.value}-${item.value}`}
                    onClick={() => {
                      onChange(pending.value);
                      onEffortChange?.(item.value);
                      changeOpen(false);
                    }}
                  >
                    {item.label}
                    <span className="text-muted-foreground block text-sm">{item.description}</span>
                  </PromptSelectionOption>
                ),
              )}
            </>
          ) : (
            groups.map((group) => (
              <section key={group.provider} aria-label={group.providerLabel}>
                <h3
                  className="text-muted-foreground px-4 py-2 text-sm font-semibold"
                  data-testid={
                    group.disabled ? `model-group-disabled-${group.provider}` : undefined
                  }
                >
                  {group.providerLabel}
                  {group.disabledReason && (
                    <span className="block font-normal">
                      {group.disabledReason === 'no-runner'
                        ? t('prompt.mobileSelectors.connectRunner', 'Connect a runner')
                        : t('prompt.mobileSelectors.notInstalled', 'Not installed on runner')}
                    </span>
                  )}
                </h3>
                {group.disabledReason !== 'no-runner' && (
                  <PromptSelectionOption
                    onClick={() => {
                      changeOpen(false);
                      setSetupProvider(group);
                    }}
                  >
                    {group.disabledReason === 'not-installed'
                      ? t('prompt.mobileSelectors.installProvider', 'Install / configure provider…')
                      : t('prompt.mobileSelectors.configureProvider', 'Configure provider…')}
                  </PromptSelectionOption>
                )}
                {group.models.map((model) => (
                  <PromptSelectionOption
                    key={model.value}
                    selected={model.value === value}
                    disabled={model.disabled || group.disabled}
                    data-testid={`prompt-model-option-${model.value}`}
                    onClick={() => {
                      if (
                        onEffortChange &&
                        getEffortLevels(parseUnifiedModel(model.value).model, group.provider)
                          .length > 0
                      )
                        setPendingModel(model.value);
                      else {
                        onChange(model.value);
                        changeOpen(false);
                      }
                    }}
                  >
                    {model.label}
                  </PromptSelectionOption>
                ))}
              </section>
            ))
          )}
        </div>
      </PromptSelectionDrawer>
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
}
