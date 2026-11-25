import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { PromptSlashResource } from '@/components/prompt-editor/PromptEditor';
import { useAdjustOnChange } from '@/hooks/use-resettable-state';
import { api } from '@/lib/api';

/**
 * Single source of truth for the provider-scoped slash `/` skills + custom
 * commands shown in a {@link PromptEditor}. Each editor surface (the composer,
 * an AskQuestion card, an ExitPlanMode card) owns exactly ONE instance of this
 * cache — the editor itself no longer caches, so switching model/provider can't
 * leave a stale list behind.
 *
 * The cache auto-invalidates whenever `projectPath` / `provider` / `model`
 * change (the fetcher's identity changes, re-running the effect).
 *
 * - `mode: 'eager'` (default) — fetches immediately on mount and on every
 *   dep change. Use for the always-mounted composer.
 * - `mode: 'lazy'` — fetches only when {@link UseSlashSkillsResult.ensureSlashSkills}
 *   is first called (i.e. the user opens the `/` menu). Use for tool cards,
 *   where many instances mount at once and most are never typed into.
 */
export interface UseSlashSkillsOptions {
  projectPath?: string;
  projectId?: string;
  provider?: string;
  model?: string;
  mode?: 'eager' | 'lazy';
}

export interface UseSlashSkillsResult {
  /** Resolved, de-duped skills + custom slash commands. Empty while loading. */
  slashSkills: PromptSlashResource[];
  /** True while a fetch is in flight. */
  slashSkillsLoading: boolean;
  /**
   * Ensure the skills are loaded and resolve with the current list. Safe to
   * call repeatedly (in-flight loads are de-duped). Wire this to the editor's
   * `onSlashOpen` for lazy surfaces, and use it on the submit path to read the
   * resolved list without racing the eager fetch.
   */
  ensureSlashSkills: () => Promise<PromptSlashResource[]>;
}

export function useSlashSkills({
  projectPath,
  projectId,
  provider,
  model,
  mode = 'eager',
}: UseSlashSkillsOptions): UseSlashSkillsResult {
  const [slashSkills, setSlashSkills] = useState<PromptSlashResource[]>([]);
  const [slashSkillsLoading, setSlashSkillsLoading] = useState(mode === 'eager');
  // Mirror for synchronous reads on the submit path.
  const slashSkillsRef = useRef<PromptSlashResource[]>(slashSkills);
  useLayoutEffect(() => {
    slashSkillsRef.current = slashSkills;
  }, [slashSkills]);
  // In-flight fetch (de-dupes concurrent ensure() calls); reset on dep change.
  const loadPromiseRef = useRef<Promise<PromptSlashResource[]> | null>(null);
  // Monotonic token so a late-resolving stale fetch can't clobber fresh state.
  const epochRef = useRef(0);

  const fetchSkills = useCallback(async (): Promise<PromptSlashResource[]> => {
    const result = await api.listAgentResources({
      projectPath,
      projectId,
      provider,
      model,
      phase: 'composer',
    });
    if (!result.isOk()) return [];
    // De-dupe by name; prefer project-scoped over global on collision.
    const deduped = new Map<string, PromptSlashResource>();
    for (const r of result.value.resources) {
      if (r.kind !== 'skill' && r.kind !== 'slash-command') continue;
      const skill: PromptSlashResource = {
        name: r.name,
        description: r.description ?? '',
        kind: r.kind,
        scope: r.scope,
        threadMode: r.threadMode,
      };
      const existing = deduped.get(skill.name);
      if (!existing || skill.scope === 'project') deduped.set(skill.name, skill);
    }
    return Array.from(deduped.values());
  }, [projectPath, projectId, provider, model]);

  /** Starts a fetch; the caller has already shown the loading state. */
  const startLoad = useCallback((): Promise<PromptSlashResource[]> => {
    const epoch = epochRef.current;
    const p = fetchSkills();
    loadPromiseRef.current = p;
    void p
      .then((skills) => {
        if (epoch === epochRef.current) setSlashSkills(skills);
      })
      .finally(() => {
        if (epoch === epochRef.current) setSlashSkillsLoading(false);
      });
    return p;
  }, [fetchSkills]);

  const runLoad = useCallback((): Promise<PromptSlashResource[]> => {
    if (loadPromiseRef.current) return loadPromiseRef.current;
    setSlashSkillsLoading(true);
    return startLoad();
  }, [startLoad]);

  // Invalidate on dep change (fetchSkills identity tracks the deps). The list
  // is cleared during render (react.dev "adjusting state when a prop changes"),
  // showing the loading state an eager fetch starts with.
  useAdjustOnChange([mode, fetchSkills], () => {
    setSlashSkills([]);
    setSlashSkillsLoading(mode === 'eager');
  });

  // Eager mode kicks off the fetch immediately; lazy mode waits for
  // ensureSlashSkills.
  useEffect(() => {
    epochRef.current += 1; // cancel any in-flight load
    loadPromiseRef.current = null;
    if (mode === 'eager') void startLoad();
  }, [mode, startLoad]);

  const ensureSlashSkills = useCallback(() => loadPromiseRef.current ?? runLoad(), [runLoad]);

  return { slashSkills, slashSkillsLoading, ensureSlashSkills };
}
