import { Building2, ChevronsUpDown, Check } from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';

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

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
}

export function OrgSwitcher() {
  const authMode = useAuthStore((s) => s.mode);
  const [orgs, setOrgs] = useState<OrgInfo[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadProjects = useProjectStore((s) => s.loadProjects);

  useEffect(() => {
    if (authMode !== 'multi') {
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
          setActiveOrgId(active.data.organizationId);
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
  }, [authMode]);

  const handleSwitch = useCallback(
    async (orgId: string) => {
      try {
        await authClient.organization.setActive({ organizationId: orgId });
        setActiveOrgId(orgId);
        // Reload data scoped to new org
        await loadProjects();
      } catch (err) {
        console.error('[OrgSwitcher] Failed to switch org:', err);
      }
    },
    [loadProjects],
  );

  if (authMode !== 'multi' || loading) return null;
  if (orgs.length === 0) return null;

  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  if (orgs.length === 1) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1.5 text-sm text-sidebar-foreground"
        data-testid="org-switcher-single"
      >
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="truncate font-medium">{orgs[0].name}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-between gap-2 px-2 text-sm font-medium"
          data-testid="org-switcher-trigger"
        >
          <span className="flex items-center gap-2 truncate">
            <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{activeOrg?.name ?? 'Select organization'}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => handleSwitch(org.id)}
            data-testid={`org-switcher-item-${org.id}`}
            className="flex items-center justify-between"
          >
            <span className="truncate">{org.name}</span>
            {org.id === activeOrgId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
