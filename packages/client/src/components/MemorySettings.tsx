import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { api, type MemoryFact, type FactType } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';

const log = createClientLogger('memory-settings');

// ─── Constants ─────────────────────────────────────────

const FACT_TYPES: { value: '' | FactType; label: string }[] = [
  { value: '', label: 'All types' },
  { value: 'decision', label: 'Decision' },
  { value: 'bug', label: 'Bug' },
  { value: 'pattern', label: 'Pattern' },
  { value: 'convention', label: 'Convention' },
  { value: 'insight', label: 'Insight' },
  { value: 'context', label: 'Context' },
];

const TYPE_COLORS: Record<FactType, string> = {
  decision: 'bg-blue-500/15 text-blue-700 dark:text-blue-400',
  bug: 'bg-red-500/15 text-red-700 dark:text-red-400',
  pattern: 'bg-purple-500/15 text-purple-700 dark:text-purple-400',
  convention: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  insight: 'bg-green-500/15 text-green-700 dark:text-green-400',
  context: 'bg-gray-500/15 text-gray-700 dark:text-gray-400',
};

// ─── Sub-components ────────────────────────────────────

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    confidence >= 0.7 ? 'bg-green-500' : confidence >= 0.4 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

const FactCard = memo(function FactCard({
  fact,
  onInvalidate,
  onEvolve,
  isInvalidating,
}: {
  fact: MemoryFact;
  onInvalidate: (id: string) => void;
  onEvolve: (fact: MemoryFact) => void;
  isInvalidating: boolean;
}) {
  const isInvalid = !!fact.invalidAt;
  return (
    <div
      data-testid={`memory-fact-${fact.id}`}
      className={cn(
        'rounded-lg border border-border/50 p-3 transition-colors',
        isInvalid && 'opacity-50',
      )}
    >
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <Badge
          variant="secondary"
          className={cn('text-[10px] font-medium', TYPE_COLORS[fact.type])}
        >
          {fact.type}
        </Badge>
        <ConfidenceBar confidence={fact.confidence} />
        <Badge variant="outline" className="text-[10px]">
          {fact.decayClass}
        </Badge>
        {isInvalid && (
          <Badge variant="destructive" className="text-[10px]">
            Invalidated
          </Badge>
        )}
      </div>

      {/* Content */}
      <p className="mb-2 whitespace-pre-wrap text-sm text-foreground">{fact.content}</p>

      {/* Meta */}
      <div className="mb-1.5 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
        {fact.sourceAgent && <span>Agent: {fact.sourceAgent}</span>}
        <span>Added: {new Date(fact.ingestedAt).toLocaleDateString()}</span>
        <span>Accessed: {fact.accessCount}x</span>
        {fact.invalidAt && (
          <span>Invalidated: {new Date(fact.invalidAt).toLocaleDateString()}</span>
        )}
      </div>

      {/* Tags */}
      {fact.tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {fact.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Actions */}
      {!isInvalid && (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => onEvolve(fact)}
            data-testid={`memory-fact-evolve-${fact.id}`}
          >
            Evolve
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => onInvalidate(fact.id)}
            disabled={isInvalidating}
            data-testid={`memory-fact-invalidate-${fact.id}`}
          >
            {isInvalidating ? 'Invalidating...' : 'Invalidate'}
          </Button>
        </div>
      )}
    </div>
  );
});

// ─── Main component ────────────────────────────────────

export function MemorySettings() {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const projects = useProjectStore((s) => s.projects);
  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const updateProject = useProjectStore((s) => s.updateProject);

  // View state
  const [view, setView] = useState<'list' | 'timeline'>('list');
  const [typeFilter, setTypeFilter] = useState<'' | FactType>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(false);
  const [gcRunning, setGcRunning] = useState(false);
  const [invalidating, setInvalidating] = useState<Set<string>>(new Set());

  // Dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [evolveTarget, setEvolveTarget] = useState<MemoryFact | null>(null);

  // Add fact form
  const [addContent, setAddContent] = useState('');
  const [addType, setAddType] = useState<FactType>('insight');
  const [addTags, setAddTags] = useState('');
  const [addConfidence, setAddConfidence] = useState('0.8');
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Evolve form
  const [evolveText, setEvolveText] = useState('');
  const [evolveSubmitting, setEvolveSubmitting] = useState(false);

  // Debounce
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const loadFacts = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoading(true);

    const filters: { type?: string; tags?: string[]; minConfidence?: number } = {};
    if (typeFilter) filters.type = typeFilter;

    let result;
    if (view === 'timeline') {
      result = await api.memoryTimeline(selectedProjectId, typeFilter ? { type: typeFilter } : {});
    } else {
      result = await api.memorySearch(selectedProjectId, searchQuery, filters);
    }

    if (result.isOk()) {
      setFacts(result.value.facts);
      log.info('facts loaded', { count: String(result.value.facts.length) });
    } else {
      log.error('memory search failed', { error: String(result.error) });
      toast.error('Failed to load memories');
    }
    setLoading(false);
  }, [selectedProjectId, view, searchQuery, typeFilter]);

  // Load on mount and filter change
  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(loadFacts, 300);
    return () => clearTimeout(timerRef.current);
  }, [loadFacts]);

  const handleInvalidate = useCallback(
    async (factId: string) => {
      if (!selectedProjectId) return;
      setInvalidating((prev) => new Set(prev).add(factId));
      const result = await api.memoryInvalidate(selectedProjectId, factId);
      if (result.isOk()) {
        setFacts((prev) => prev.filter((f) => f.id !== factId));
        toast.success('Fact invalidated');
      } else {
        toast.error('Failed to invalidate fact');
      }
      setInvalidating((prev) => {
        const next = new Set(prev);
        next.delete(factId);
        return next;
      });
    },
    [selectedProjectId],
  );

  const handleEvolve = useCallback((fact: MemoryFact) => {
    setEvolveTarget(fact);
    setEvolveText('');
  }, []);

  const submitEvolve = async () => {
    if (!selectedProjectId || !evolveTarget || !evolveText.trim()) return;
    setEvolveSubmitting(true);
    const result = await api.memoryEvolve(selectedProjectId, evolveTarget.id, evolveText.trim());
    if (result.isOk()) {
      setFacts((prev) => prev.map((f) => (f.id === evolveTarget.id ? result.value : f)));
      setEvolveTarget(null);
      toast.success('Fact evolved');
    } else {
      toast.error('Failed to evolve fact');
    }
    setEvolveSubmitting(false);
  };

  const submitAdd = async () => {
    if (!selectedProjectId || !addContent.trim() || !addType) return;
    setAddSubmitting(true);
    const tags = addTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const confidence = parseFloat(addConfidence) || 0.8;
    const result = await api.memoryAddFact(selectedProjectId, {
      content: addContent.trim(),
      type: addType,
      tags: tags.length ? tags : undefined,
      confidence,
    });
    if (result.isOk()) {
      setAddOpen(false);
      setAddContent('');
      setAddTags('');
      setAddConfidence('0.8');
      loadFacts();
      toast.success('Fact added');
    } else {
      toast.error('Failed to add fact');
    }
    setAddSubmitting(false);
  };

  const handleGC = async () => {
    if (!selectedProjectId) return;
    setGcRunning(true);
    const result = await api.memoryRunGC(selectedProjectId);
    if (result.isOk()) {
      const { archived, deduplicated, orphaned } = result.value;
      toast.success(
        `GC complete: ${archived} archived, ${deduplicated} deduped, ${orphaned} orphaned`,
      );
      loadFacts();
    } else {
      toast.error('GC failed');
    }
    setGcRunning(false);
  };

  // Guard: no project
  if (!selectedProjectId || !selectedProject) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('settings.selectProject', 'Select a project to view memories.')}
      </p>
    );
  }

  // Guard: memory disabled
  if (!selectedProject.memoryEnabled) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          Memory is disabled for this project. Enable it to let agents store and recall knowledge
          across sessions.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            updateProject(selectedProject.id, { memoryEnabled: true });
            toast.success('Memory enabled');
          }}
          data-testid="memory-enable"
        >
          Enable Memory
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {/* View toggle */}
        <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
          <button
            onClick={() => setView('list')}
            aria-pressed={view === 'list'}
            data-testid="memory-view-list"
            className={cn(
              'px-2.5 py-1 text-xs rounded-sm transition-colors',
              view === 'list'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Search
          </button>
          <button
            onClick={() => setView('timeline')}
            aria-pressed={view === 'timeline'}
            data-testid="memory-view-timeline"
            className={cn(
              'px-2.5 py-1 text-xs rounded-sm transition-colors',
              view === 'timeline'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Timeline
          </button>
        </div>

        {/* Type filter */}
        <Select
          value={typeFilter || '__all__'}
          onValueChange={(v) => setTypeFilter(v === '__all__' ? '' : (v as FactType))}
        >
          <SelectTrigger className="h-8 w-[130px] text-xs" data-testid="memory-type-filter">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            {FACT_TYPES.map((ft) => (
              <SelectItem
                key={ft.value || '__all__'}
                value={ft.value || '__all__'}
                className="text-xs"
              >
                {ft.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Search (list mode only) */}
        {view === 'list' && (
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search memories..."
            className="h-8 w-[200px] text-xs"
            data-testid="memory-search"
          />
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddOpen(true)}
            className="h-8 text-xs"
            data-testid="memory-add-fact"
          >
            Add Fact
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleGC}
            disabled={gcRunning}
            className="h-8 text-xs"
            data-testid="memory-run-gc"
          >
            {gcRunning ? 'Running GC...' : 'Run GC'}
          </Button>
        </div>
      </div>

      <Separator />

      {/* Fact list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">Loading memories...</p>
        </div>
      ) : facts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12">
          <p className="text-sm text-muted-foreground">No memories found.</p>
          <p className="text-xs text-muted-foreground">
            Agents will automatically store knowledge here as they work.
          </p>
        </div>
      ) : (
        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-3 pr-4">
            {facts.map((fact) => (
              <FactCard
                key={fact.id}
                fact={fact}
                onInvalidate={handleInvalidate}
                onEvolve={handleEvolve}
                isInvalidating={invalidating.has(fact.id)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <div className="text-xs text-muted-foreground">
        {facts.length} {facts.length === 1 ? 'fact' : 'facts'}
      </div>

      {/* Add Fact Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Memory Fact</DialogTitle>
            <DialogDescription>
              Store a non-obvious piece of knowledge for future agent sessions.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Textarea
              value={addContent}
              onChange={(e) => setAddContent(e.target.value)}
              placeholder="What should agents remember?"
              className="min-h-[100px] text-sm"
              data-testid="memory-add-dialog-content"
            />
            <div className="flex items-center gap-2">
              <Select value={addType} onValueChange={(v) => setAddType(v as FactType)}>
                <SelectTrigger
                  className="h-8 w-[140px] text-xs"
                  data-testid="memory-add-dialog-type"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FACT_TYPES.filter((ft) => ft.value !== '').map((ft) => (
                    <SelectItem key={ft.value} value={ft.value} className="text-xs">
                      {ft.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={addConfidence}
                onChange={(e) => setAddConfidence(e.target.value)}
                placeholder="Confidence (0-1)"
                className="h-8 w-[100px] text-xs"
                type="number"
                min="0"
                max="1"
                step="0.1"
                data-testid="memory-add-dialog-confidence"
              />
            </div>
            <Input
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
              placeholder="Tags (comma-separated)"
              className="h-8 text-xs"
              data-testid="memory-add-dialog-tags"
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={submitAdd}
                disabled={!addContent.trim() || addSubmitting}
                data-testid="memory-add-dialog-submit"
              >
                {addSubmitting ? 'Adding...' : 'Add Fact'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Evolve Dialog */}
      <Dialog open={!!evolveTarget} onOpenChange={(open) => !open && setEvolveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Evolve Fact</DialogTitle>
            <DialogDescription>
              Update this fact with new information. The original will be preserved in history.
            </DialogDescription>
          </DialogHeader>
          {evolveTarget && (
            <div className="flex flex-col gap-3">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Current content</p>
                <div className="rounded-md bg-muted/50 p-2 text-sm">{evolveTarget.content}</div>
              </div>
              <Textarea
                value={evolveText}
                onChange={(e) => setEvolveText(e.target.value)}
                placeholder="Updated content..."
                className="min-h-[80px] text-sm"
                data-testid="memory-evolve-dialog-update"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEvolveTarget(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={submitEvolve}
                  disabled={!evolveText.trim() || evolveSubmitting}
                  data-testid="memory-evolve-dialog-submit"
                >
                  {evolveSubmitting ? 'Evolving...' : 'Evolve'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
