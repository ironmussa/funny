import type { WSCloneProgressData } from '@funny/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useStableCallback } from '@/hooks/use-stable-callback';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';

import type { ViewState } from './clone-view-state';

const log = createClientLogger('clone-repo-view');

interface CloneProgressDeps {
  t: ReturnType<typeof useTranslation>['t'];
  navigate: ReturnType<typeof useNavigate>;
  loadProjects: () => Promise<void>;
  setAddProjectOpen: (open: boolean) => void;
  setIsCloning: (cloning: boolean) => void;
  setView: (view: ViewState) => void;
}

/**
 * Follows the clone this view started through its `clone:progress` events:
 * phase and percent while it runs, then the outcome when it ends.
 */
export function useCloneProgress({
  t,
  navigate,
  loadProjects,
  setAddProjectOpen,
  setIsCloning,
  setView,
}: CloneProgressDeps) {
  const [clonePhase, setClonePhase] = useState('');
  const [clonePercent, setClonePercent] = useState<number | undefined>(undefined);
  const [phaseChanged, setPhaseChanged] = useState(false);
  const prevPhaseRef = useRef('');
  /** The clone this view started; events of any other clone are ignored. */
  const activeCloneIdRef = useRef<string | null>(null);

  // The runner answers as soon as the clone starts; its last `clone:progress`
  // event says whether the project was created.
  const finishClone = useStableCallback(async (data: WSCloneProgressData) => {
    activeCloneIdRef.current = null;
    setIsCloning(false);
    if (data.status === 'failed') {
      log.warn('clone failed', { cloneId: data.cloneId, error: data.error });
      toast.error(t('github.clone.failed', { error: data.error ?? '' }));
      setView('clone-config');
      return;
    }
    toast.success(t('github.clone.success'));
    await loadProjects();
    setAddProjectOpen(false);
    if (data.projectId) navigate(buildPath(`/projects/${data.projectId}`));
  });

  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent<WSCloneProgressData>).detail;
      if (!activeCloneIdRef.current || data.cloneId !== activeCloneIdRef.current) return;
      if (data.status === 'done' || data.status === 'failed') {
        void finishClone(data);
        return;
      }
      if (data.phase) {
        const newPhase = data.phase.replace(/:.*$/, '').trim();
        const oldPhase = prevPhaseRef.current;
        if (newPhase !== oldPhase) {
          setPhaseChanged(true);
          prevPhaseRef.current = newPhase;
          // Re-enable transition on next frame so only the reset is instant
          requestAnimationFrame(() => setPhaseChanged(false));
        }
        setClonePhase(data.phase);
      }
      if (data.percent !== undefined) setClonePercent(data.percent);
    };
    window.addEventListener('clone:progress', handler);
    return () => window.removeEventListener('clone:progress', handler);
  }, [finishClone]);

  return {
    clonePhase,
    setClonePhase,
    clonePercent,
    setClonePercent,
    phaseChanged,
    activeCloneIdRef,
  };
}
