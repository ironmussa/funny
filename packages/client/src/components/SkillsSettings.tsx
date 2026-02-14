import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Trash2,
  Plus,
  Loader2,
  Download,
  Sparkles,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Puzzle,
} from 'lucide-react';
import type { Skill, Plugin, PluginCommand } from '@a-parallel/shared';

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
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border/50 bg-card">
      <div className="flex items-center gap-3 min-w-0">
        <Sparkles className="h-4 w-4 text-amber-500 flex-shrink-0" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{skill.name}</span>
          </div>
          {skill.description && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {skill.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-1">
            <span className="text-xs text-muted-foreground/70">
              {skill.source}
            </span>
            {skill.sourceUrl && (
              <a
                href={skill.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground/70 hover:text-foreground inline-flex items-center gap-0.5"
              >
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            )}
            {skill.installedAt && (
              <span className="text-xs text-muted-foreground/70">
                installed {new Date(skill.installedAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>
      {skill.scope !== 'project' && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          disabled={removing}
          className="text-muted-foreground hover:text-destructive flex-shrink-0"
        >
          {removing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
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
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border border-border/50 bg-card">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{skill.name}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{skill.description}</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5 font-mono">
          {skill.identifier}
        </p>
      </div>
      <Button
        variant={installed ? 'ghost' : 'outline'}
        size="sm"
        onClick={onInstall}
        disabled={installed || installing}
        className="flex-shrink-0 text-xs h-7"
      >
        {installing ? (
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
        ) : installed ? null : (
          <Download className="h-3 w-3 mr-1" />
        )}
        {installed ? t('skills.installed') : installing ? t('skills.installing') : t('skills.install')}
      </Button>
    </div>
  );
}

function PluginCommandRow({ command }: { command: PluginCommand }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className="font-mono text-foreground/80">/{command.name}</span>
      {command.description && (
        <span className="text-muted-foreground/70 truncate">
          {command.description}
        </span>
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
      <div className="rounded-md border border-border/50 bg-card">
        <CollapsibleTrigger asChild>
          <button
            className="flex items-center justify-between gap-3 px-3 py-2.5 w-full text-left hover:bg-muted/30 transition-colors rounded-md"
            disabled={!hasCommands}
          >
            <div className="flex items-center gap-3 min-w-0">
              <Puzzle className="h-4 w-4 text-purple-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{plugin.name}</span>
                  {hasCommands && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                      {plugin.commands.length} {plugin.commands.length === 1 ? t('plugins.command') : t('plugins.commands')}
                    </span>
                  )}
                </div>
                {plugin.description && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {plugin.description}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-1">
                  {plugin.author && (
                    <span className="text-xs text-muted-foreground/70">
                      {t('plugins.by')} {plugin.author}
                    </span>
                  )}
                  {plugin.installedAt && (
                    <span className="text-xs text-muted-foreground/70">
                      installed {new Date(plugin.installedAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {hasCommands && (
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 text-muted-foreground transition-transform flex-shrink-0',
                  open && 'rotate-180'
                )}
              />
            )}
          </button>
        </CollapsibleTrigger>
        {hasCommands && (
          <CollapsibleContent>
            <div className="border-t border-border/50 py-1">
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
  const projects = useAppStore(s => s.projects);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
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
    ? projects.find((p) => p.id === selectedProjectId)?.path ?? null
    : projects[0]?.path ?? null;

  const loadSkills = useCallback(async () => {
    setLoading(true);
    const result = await api.listSkills(projectPath || undefined);
    if (result.isOk()) {
      setSkills(result.value.skills);
    } else {
      toast.error(result.error.message);
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
      toast.error(result.error.message);
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
      toast.error(result.error.message);
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
      toast.error(result.error.message);
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
      {/* Project indicator */}
      {projectPath && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" />
          <span>
            {t('skills.showingFor')}{' '}
            <span className="font-medium text-foreground">
              {projects.find((p) => p.path === projectPath)?.name || projectPath}
            </span>
          </span>
        </div>
      )}

      {/* Project skills */}
      {projectSkills.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
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
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('skills.globalSkills')}
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCustom(!showCustom)}
            className="text-xs h-6 px-2"
          >
            {showCustom ? (
              <ChevronUp className="h-3 w-3 mr-1" />
            ) : (
              <Plus className="h-3 w-3 mr-1" />
            )}
            {showCustom ? t('skills.cancel') : t('skills.addCustom')}
          </Button>
        </div>

        {/* Custom install form */}
        {showCustom && (
          <div className="rounded-lg border border-border/50 p-3 mb-3 space-y-2 bg-muted/30">
            <label className="text-xs text-muted-foreground block">
              {t('skills.skillIdentifier')} (e.g. <code className="text-xs bg-muted px-1 py-0.5 rounded">owner/repo@skill-name</code>)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="vercel-labs/agent-skills@nextjs-best-practices"
                className="flex-1 h-8 px-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring font-mono text-xs"
                onKeyDown={(e) => e.key === 'Enter' && handleAddCustom()}
              />
              <Button
                size="sm"
                onClick={handleAddCustom}
                disabled={!customId.trim() || addingCustom}
                className="text-xs h-8"
              >
                {addingCustom ? (
                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                ) : (
                  <Plus className="h-3 w-3 mr-1" />
                )}
                {t('skills.install')}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('skills.loadingSkills')}
          </div>
        ) : globalSkills.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
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
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('plugins.installedPlugins')}
          </h3>
          <span className="text-xs text-muted-foreground/60">
            {t('plugins.managedByClaudeCode')}
          </span>
        </div>

        {loadingPlugins ? (
          <div className="flex items-center gap-2 py-6 justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('plugins.loadingPlugins')}
          </div>
        ) : plugins.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
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
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
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
