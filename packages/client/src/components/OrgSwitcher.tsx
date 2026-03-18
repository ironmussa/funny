import { Building2, User } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { authClient } from '@/lib/auth-client';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
}

const PERSONAL_VALUE = '__personal__';

export function OrgSwitcher() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setActiveOrg = useAuthStore((s) => s.setActiveOrg);
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  // Read the org restored by auth-store.initialize() so we don't re-fetch
  const restoredOrgId = useAuthStore((s) => s.activeOrgId);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(restoredOrgId);
  const [loading, setLoading] = useState(true);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const navigate = useNavigate();

  // Keep local state in sync when the auth store restores the org
  useEffect(() => {
    setActiveOrgId(restoredOrgId);
  }, [restoredOrgId]);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await authClient.organization.list();
        if (!cancelled && res.data) {
          setOrgs(res.data.map((o: any) => ({ id: o.id, name: o.name, slug: o.slug })));
        }
        // The active org is already restored by auth-store.initialize().
        // Only fetch it here if it wasn't restored (e.g. initialize ran
        // before the org plugin was ready).
        if (!cancelled && !useAuthStore.getState().activeOrgId) {
          const active = await authClient.organization.getActiveMember();
          if (!cancelled && active.data) {
            const orgId = active.data.organizationId;
            setActiveOrgId(orgId);
            const orgInfo = res.data?.find((o: any) => o.id === orgId);
            setActiveOrg(orgId, orgInfo?.name ?? null, orgInfo?.slug ?? null);
          }
        }
      } catch (err) {
        console.error('[OrgSwitcher] Failed to load orgs:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, setActiveOrg]);

  const clearAndReload = useCallback(async () => {
    useThreadStore.setState({
      threadsByProject: {},
      selectedThreadId: null,
      activeThread: null,
    });
    await loadProjects();
  }, [loadProjects]);

  const handleValueChange = useCallback(
    async (value: string) => {
      if (value === PERSONAL_VALUE) {
        try {
          await authClient.organization.setActive({ organizationId: null as any });
          setActiveOrgId(null);
          useAuthStore.getState().setActiveOrg(null, null, null);
          await clearAndReload();
          navigate('/');
        } catch (err) {
          console.error('[OrgSwitcher] Failed to switch to personal:', err);
        }
      } else {
        try {
          await authClient.organization.setActive({ organizationId: value });
          setActiveOrgId(value);
          const orgInfo = orgs.find((o) => o.id === value);
          useAuthStore.getState().setActiveOrg(value, orgInfo?.name ?? null, orgInfo?.slug ?? null);
          await clearAndReload();
          if (orgInfo?.slug) navigate(`/${orgInfo.slug}/`);
        } catch (err) {
          console.error('[OrgSwitcher] Failed to switch org:', err);
        }
      }
    },
    [orgs, clearAndReload, navigate],
  );

  if (loading) return null;
  if (orgs.length === 0) return null;

  const selectValue = activeOrgId ?? PERSONAL_VALUE;

  return (
    <Select value={selectValue} onValueChange={handleValueChange}>
      <SelectTrigger
        data-testid="org-switcher-trigger"
        size="sm"
        className="w-full border-none bg-transparent shadow-none"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={PERSONAL_VALUE} size="sm" data-testid="org-switcher-item-personal">
          <span className="flex items-center gap-2">
            <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>Personal</span>
          </span>
        </SelectItem>
        {orgs.map((org) => (
          <SelectItem
            key={org.id}
            value={org.id}
            size="sm"
            data-testid={`org-switcher-item-${org.id}`}
          >
            <span className="flex items-center gap-2">
              <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{org.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
