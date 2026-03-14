import { Building2, ChevronsUpDown, Check, User } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient } from '@/lib/auth-client';
import { useAuthStore } from '@/stores/auth-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
}

export function OrgSwitcher() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setActiveOrg = useAuthStore((s) => s.setActiveOrg);
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const navigate = useNavigate();

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
        const active = await authClient.organization.getActiveMember();
        if (!cancelled && active.data) {
          const orgId = active.data.organizationId;
          setActiveOrgId(orgId);
          const orgInfo = res.data?.find((o: any) => o.id === orgId);
          setActiveOrg(orgId, orgInfo?.name ?? null, orgInfo?.slug ?? null);
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

  const handleSwitch = useCallback(
    async (orgId: string) => {
      try {
        await authClient.organization.setActive({ organizationId: orgId });
        setActiveOrgId(orgId);
        const orgInfo = orgs.find((o) => o.id === orgId);
        useAuthStore.getState().setActiveOrg(orgId, orgInfo?.name ?? null, orgInfo?.slug ?? null);
        await clearAndReload();
        // Navigate to org-scoped root
        if (orgInfo?.slug) navigate(`/${orgInfo.slug}/`);
      } catch (err) {
        console.error('[OrgSwitcher] Failed to switch org:', err);
      }
    },
    [orgs, clearAndReload, navigate],
  );

  const handleSwitchToPersonal = useCallback(async () => {
    try {
      // Better Auth: setting active org to null deactivates the org context
      await authClient.organization.setActive({ organizationId: null as any });
      setActiveOrgId(null);
      useAuthStore.getState().setActiveOrg(null, null, null);
      await clearAndReload();
      // Navigate to personal root (no prefix)
      navigate('/');
    } catch (err) {
      console.error('[OrgSwitcher] Failed to switch to personal:', err);
    }
  }, [clearAndReload, navigate]);

  if (loading) return null;
  if (orgs.length === 0) return null;

  const activeOrg = orgs.find((o) => o.id === activeOrgId);
  const displayLabel = activeOrg?.name ?? 'Personal';
  const DisplayIcon = activeOrg ? Building2 : User;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between gap-2 px-2 text-sm font-medium"
          data-testid="org-switcher-trigger"
        >
          <span className="flex items-center gap-2 truncate">
            <DisplayIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{displayLabel}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuItem
          onClick={handleSwitchToPersonal}
          data-testid="org-switcher-item-personal"
          className="flex items-center justify-between"
        >
          <span className="flex items-center gap-2">
            <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>Personal</span>
          </span>
          {activeOrgId === null && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
        </DropdownMenuItem>
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => handleSwitch(org.id)}
            data-testid={`org-switcher-item-${org.id}`}
            className="flex items-center justify-between"
          >
            <span className="flex items-center gap-2">
              <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{org.name}</span>
            </span>
            {org.id === activeOrgId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
