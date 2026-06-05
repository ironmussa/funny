import type { Skill, Plugin, PluginCommand } from '@funny/shared';
import {
  Trash2,
  Plus,
  Loader2,
  Download,
  Sparkles,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Puzzle,
} from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { colorFromName } from '@/components/ui/project-chip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

interface RecommendedSkill {
  name: string;
  description: string;
  identifier: string;
}

function InstalledSkillCard({
  skill,
  onRemove,
  removing,
}: {
  skill: Skill;
  onRemove: () => void;
  removing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="border-border/50 bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      style={{ borderLeftWidth: 3, borderLeftColor: colorFromName(skill.name) }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Sparkles className="icon-base text-status-warning shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{skill.name}</span>
          </div>
          {skill.description && (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">{skill.description}</p>
          )}
          <div className="mt-1 flex items-center gap-2">
            <span className="text-muted-foreground/70 text-xs">{skill.source}</span>
            {skill.sourceUrl && (
              <a
                href={skill.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-0.5 text-xs"
              >
                <ExternalLink className="icon-2xs" />
              </a>
            )}
            {skill.installedAt && (
              <span className="text-muted-foreground/70 text-xs">
                installed {new Date(skill.installedAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>
      {skill.scope !== 'project' && (
        <TooltipIconButton
          onClick={onRemove}
          disabled={removing}
          className="text-muted-foreground hover:text-destructive shrink-0"
          tooltip={t('common.remove')}
        >
          {removing ? <Loader2 className="icon-sm animate-spin" /> : <Trash2 className="icon-sm" />}
        </TooltipIconButton>
      )}
    </div>
  );
}

function RecommendedSkillCard({
  skill,
  installed,
  onInstall,
  installing,
}: {
  skill: RecommendedSkill;
  installed: boolean;
  onInstall: () => void;
  installing: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="border-border/50 bg-card flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
      style={{ borderLeftWidth: 3, borderLeftColor: colorFromName(skill.name) }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{skill.name}</span>
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">{skill.description}</p>
        <p className="text-muted-foreground/70 mt-0.5 font-mono text-xs">{skill.identifier}</p>
      </div>
      <Button
        variant={installed ? 'ghost' : 'outline'}
        size="sm"
        onClick={onInstall}
        disabled={installed || installing}
        className="shrink-0"
      >
        {installing ? (
          <Loader2 className="icon-xs mr-1 animate-spin" />
        ) : installed ? null : (
          <Download className="icon-xs mr-1" />
        )}
        {installed
          ? t('skills.installed')
          : installing
            ? t('skills.installing')
            : t('skills.install')}
      </Button>
    </div>
  );
}

function PluginCommandRow({ command }: { command: PluginCommand }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className="text-foreground/80 font-mono">/{command.name}</span>
      {command.description && (
        <span className="text-muted-foreground/70 truncate">{command.description}</span>
      )}
    </div>
  );
}

function PluginCard({ plugin }: { plugin: Plugin }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasCommands = plugin.commands.length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className="border-border/50 bg-card rounded-md border"
        style={{ borderLeftWidth: 3, borderLeftColor: colorFromName(plugin.name) }}
      >
        <CollapsibleTrigger asChild>
          <button
            className="hover:bg-muted/30 flex w-full items-center justify-between gap-3 rounded-md px-3 py-2.5 text-left transition-colors"
            disabled={!hasCommands}
          >
            <div className="flex min-w-0 items-center gap-3">
              <Puzzle className="icon-base shrink-0 text-purple-500" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{plugin.name}</span>
                  {hasCommands && (
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-medium">
                      {plugin.commands.length}{' '}
                      {plugin.commands.length === 1 ? t('plugins.command') : t('plugins.commands')}
                    </span>
                  )}
                </div>
                {plugin.description && (
                  <p className="text-muted-foreground mt-0.5 truncate text-xs">
                    {plugin.description}
                  </p>
                )}
                <div className="mt-1 flex items-center gap-2">
                  {plugin.author && (
                    <span className="text-muted-foreground/70 text-xs">
                      {t('plugins.by')} {plugin.author}
                    </span>
                  )}
                  {plugin.installedAt && (
                    <span className="text-muted-foreground/70 text-xs">
                      installed {new Date(plugin.installedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {hasCommands && (
              <ChevronDown
                className={cn(
                  'icon-sm text-muted-foreground transition-transform shrink-0',
                  open && 'rotate-180',
                )}
              />
            )}
          </button>
        </CollapsibleTrigger>
        {hasCommands && (
          <CollapsibleContent>
            <div className="border-border/50 border-t py-1">
              {plugin.commands.map((cmd) => (
                <PluginCommandRow key={cmd.name} command={cmd} />
              ))}
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}

export function SkillsSettings() {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [recommended, setRecommended] = useState<RecommendedSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customId, setCustomId] = useState('');
  const [addingCustom, setAddingCustom] = useState(false);

  // Derive project path synchronously to avoid race conditions
  const projectPath = selectedProjectId
    ? (projects.find((p) => p.id === selectedProjectId)?.path ?? null)
    : (projects[0]?.path ?? null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    const result = await api.listSkills(projectPath || undefined);
    if (result.isOk()) {
      setSkills(result.value.skills);
    } else {
      toastError(result.error);
    }
    setLoading(false);
  }, [projectPath]);

  const loadPlugins = useCallback(async () => {
    setLoadingPlugins(true);
    const result = await api.listPlugins();
    if (result.isOk()) {
      setPlugins(result.value.plugins);
    }
    // Silently fail — plugins are optional
    setLoadingPlugins(false);
  }, []);

  const loadRecommended = useCallback(async () => {
    const result = await api.getRecommendedSkills();
    if (result.isOk()) {
      setRecommended(result.value.skills as unknown as RecommendedSkill[]);
    }
    // Silently fail
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  useEffect(() => {
    loadRecommended();
  }, [loadRecommended]);

  const handleRemove = async (name: string) => {
    setRemovingName(name);
    const result = await api.removeSkill(name);
    if (result.isErr()) {
      toastError(result.error);
    } else {
      await loadSkills();
      toast.success(`Skill "${name}" removed`);
    }
    setRemovingName(null);
  };

  const handleInstallRecommended = async (skill: RecommendedSkill) => {
    setInstallingId(skill.identifier);
    const result = await api.addSkill(skill.identifier);
    if (result.isErr()) {
      toastError(result.error);
    } else {
      await loadSkills();
      toast.success(`Skill "${skill.name}" installed successfully`);
    }
    setInstallingId(null);
  };

  const handleAddCustom = async () => {
    const id = customId.trim();
    if (!id) return;
    setAddingCustom(true);
    const result = await api.addSkill(id);
    if (result.isErr()) {
      toastError(result.error);
    } else {
      await loadSkills();
      toast.success(`Skill "${id}" installed successfully`);
      setCustomId('');
      setShowCustom(false);
    }
    setAddingCustom(false);
  };

  const projectSkills = skills.filter((s) => s.scope === 'project');
  const globalSkills = skills.filter((s) => s.scope !== 'project');
  const installedNames = new Set(skills.map((s) => s.name));

  return (
    <div className="space-y-6">
      {/* Project skills */}
      {projectSkills.length > 0 && (
        <div>
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
            {t('skills.projectSkills')}
          </h3>
          <div className="space-y-1.5">
            {projectSkills.map((skill) => (
              <InstalledSkillCard
                key={`project-${skill.name}`}
                skill={skill}
                onRemove={() => {}}
                removing={false}
              />
            ))}
          </div>
        </div>
      )}

      {/* Global skills */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            {t('skills.globalSkills')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCustom(!showCustom)}
            className="px-2"
          >
            {showCustom ? (
              <ChevronUp className="icon-xs mr-1" />
            ) : (
              <Plus className="icon-xs mr-1" />
            )}
            {showCustom ? t('skills.cancel') : t('skills.addCustom')}
          </Button>
        </div>

        {/* Custom install form */}
        {showCustom && (
          <div className="border-border/50 bg-muted/30 mb-3 space-y-2 rounded-lg border p-3">
            <label className="text-muted-foreground block text-xs">
              {t('skills.skillIdentifier')} (e.g.{' '}
              <code className="bg-muted rounded px-1 py-0.5 text-xs">owner/repo@skill-name</code>)
            </label>
            <div className="flex gap-2">
              <Input
                type="text"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="vercel-labs/agent-skills@nextjs-best-practices"
                className="h-8 flex-1 px-2 font-mono text-xs"
                onKeyDown={(e) => e.key === 'Enter' && handleAddCustom()}
              />
              <Button
                size="sm"
                onClick={handleAddCustom}
                disabled={!customId.trim() || addingCustom}
                className="h-8 text-xs"
              >
                {addingCustom ? (
                  <Loader2 className="icon-xs mr-1 animate-spin" />
                ) : (
                  <Plus className="icon-xs mr-1" />
                )}
                {t('skills.install')}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <LoadingState
            fill={false}
            layout="inline"
            className="py-6"
            testId="skills-loading"
            label={t('skills.loadingSkills')}
          />
        ) : globalSkills.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            {t('skills.noGlobalSkills')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {globalSkills.map((skill) => (
              <InstalledSkillCard
                key={skill.name}
                skill={skill}
                onRemove={() => handleRemove(skill.name)}
                removing={removingName === skill.name}
              />
            ))}
          </div>
        )}
      </div>

      {/* Installed plugins */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            {t('plugins.installedPlugins')}
          </h3>
          <span className="text-muted-foreground/60 text-xs">
            {t('plugins.managedByClaudeCode')}
          </span>
        </div>

        {loadingPlugins ? (
          <LoadingState
            fill={false}
            layout="inline"
            className="py-6"
            testId="skills-loading-plugins"
            label={t('plugins.loadingPlugins')}
          />
        ) : plugins.length === 0 ? (
          <div className="text-muted-foreground py-4 text-center text-sm">
            {t('plugins.noPlugins')}
          </div>
        ) : (
          <div className="space-y-1.5">
            {plugins.map((plugin) => (
              <PluginCard key={plugin.name} plugin={plugin} />
            ))}
          </div>
        )}
      </div>

      {/* Recommended skills */}
      {recommended.length > 0 && (
        <div>
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
            {t('skills.recommendedSkills')}
          </h3>
          <div className="space-y-1.5">
            {recommended.map((skill) => (
              <RecommendedSkillCard
                key={skill.identifier}
                skill={skill}
                installed={installedNames.has(skill.name)}
                onInstall={() => handleInstallRecommended(skill)}
                installing={installingId === skill.identifier}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
