import { useEffect } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';
import { toast } from 'sonner';

import { authClient } from '@/lib/auth-client';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

function resetThreadStore() {
  useThreadStore.setState({
    threadsById: {},
    threadIdsByProject: {},
    scratchThreadIds: [],
    threadTotalByProject: {},
    scratchThreadTotal: 0,
    selectedThreadId: null,
    activeThread: null,
  });
}

async function switchToOrg(orgSlug: string, navigate: NavigateFunction) {
  try {
    const res = await authClient.organization.list();
    const orgList = res.data ?? [];
    const targetOrg = orgList.find((o: { slug: string }) => o.slug === orgSlug);
    if (!targetOrg) {
      toast.error(`Organization "${orgSlug}" not found`);
      navigate('/');
      return;
    }
    await authClient.organization.setActive({ organizationId: targetOrg.id });
    useAuthStore.getState().setActiveOrg(targetOrg.id, targetOrg.name, targetOrg.slug);
    resetThreadStore();
    await useProjectStore.getState().loadProjects();
  } catch (err) {
    console.error('[useOrgAutoSwitch] Failed to auto-switch org:', err);
    toast.error('Failed to switch organization');
    navigate('/');
  }
}

async function switchToPersonal() {
  try {
    await authClient.organization.setActive({ organizationId: null as unknown as string });
    useAuthStore.getState().setActiveOrg(null, null, null);
    resetThreadStore();
    await useProjectStore.getState().loadProjects();
  } catch (err) {
    console.error('[useOrgAutoSwitch] Failed to switch to personal:', err);
  }
}

export function useOrgAutoSwitch(initialized: boolean, orgSlug: string | null) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!initialized) return;
    const currentSlug = useAuthStore.getState().activeOrgSlug;
    if (orgSlug && orgSlug !== currentSlug) {
      void switchToOrg(orgSlug, navigate);
    } else if (!orgSlug && currentSlug) {
      void switchToPersonal();
    }
  }, [initialized, orgSlug, navigate]);
}
