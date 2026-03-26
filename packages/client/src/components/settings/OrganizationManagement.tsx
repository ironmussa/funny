import { Building2, Check, Trash2 } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authClient } from '@/lib/auth-client';
import { useProjectStore } from '@/stores/project-store';

interface OrgEntry {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function OrganizationManagement() {
  const [orgs, setOrgs] = useState<OrgEntry[]>([]);
  const [memberships, setMemberships] = useState<Map<string, string>>(new Map());
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<OrgEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadProjects = useProjectStore((s) => s.loadProjects);

  const loadOrgs = useCallback(async () => {
    try {
      const res = await authClient.organization.list();
      if (res.data) {
        setOrgs(
          res.data.map((o: any) => ({
            id: o.id,
            name: o.name,
            slug: o.slug,
            createdAt: o.createdAt || '',
          })),
        );
        // Build membership map (orgId -> role)
        const memberMap = new Map<string, string>();
        const session = await authClient.getSession();
        const currentUserId = session.data?.user?.id;
        for (const org of res.data) {
          try {
            const full = await authClient.organization.getFullOrganization({
              query: { organizationId: (org as any).id },
            });
            if (full.data) {
              const me = (full.data as any).members?.find((m: any) => m.userId === currentUserId);
              if (me) {
                memberMap.set((org as any).id, me.role);
              }
            }
          } catch {
            // Skip if we can't get full org details
          }
        }
        setMemberships(memberMap);
      }
      // Get active org
      try {
        const active = await authClient.organization.getActiveMember();
        if (active.data) {
          setActiveOrgId(active.data.organizationId);
        }
      } catch {
        // No active org
      }
    } catch (err) {
      console.error('[OrganizationManagement] Failed to load orgs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrgs();
  }, [loadOrgs]);

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim() || slugify(trimmedName);
    if (!trimmedName || !trimmedSlug) return;

    setCreating(true);
    try {
      await authClient.organization.create({
        name: trimmedName,
        slug: trimmedSlug,
      });
      toast.success(`Organization "${trimmedName}" created`);
      setName('');
      setSlug('');
      setSlugManuallyEdited(false);
      await loadOrgs();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create organization');
    } finally {
      setCreating(false);
    }
  }, [name, slug, loadOrgs]);

  const handleSetActive = useCallback(
    async (orgId: string) => {
      try {
        await authClient.organization.setActive({ organizationId: orgId });
        setActiveOrgId(orgId);
        await loadProjects();
        toast.success('Active organization switched');
      } catch (err: any) {
        toast.error(err.message || 'Failed to switch organization');
      }
    },
    [loadProjects],
  );

  const handleDelete = useCallback(async () => {
    if (!deleteConfirm) return;
    setDeleting(true);
    try {
      await authClient.organization.delete({
        organizationId: deleteConfirm.id,
      });
      toast.success(`Organization "${deleteConfirm.name}" deleted`);
      setDeleteConfirm(null);
      await loadOrgs();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete organization');
    } finally {
      setDeleting(false);
    }
  }, [deleteConfirm, loadOrgs]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading organizations...
      </div>
    );
  }

  return (
    <>
      {/* Create Organization */}
      <h3 className="settings-section-header">Create Organization</h3>
      <div className="settings-card">
        <div className="px-4 py-3.5">
          <p className="mb-3 text-xs text-muted-foreground">
            Create a new organization to manage team members and projects.
          </p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugManuallyEdited) {
                    setSlug(slugify(e.target.value));
                  }
                }}
                placeholder="My Organization"
                className="text-sm"
                data-testid="org-create-name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Slug</label>
              <Input
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSlugManuallyEdited(true);
                }}
                placeholder="my-organization"
                className="font-mono text-sm"
                data-testid="org-create-slug"
              />
            </div>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={creating || !name.trim()}
              data-testid="org-create-submit"
            >
              {creating ? 'Creating...' : 'Create Organization'}
            </Button>
          </div>
        </div>
      </div>

      {/* Your Organizations */}
      <h3 className="settings-section-header">Your Organizations ({orgs.length})</h3>
      <div className="settings-card">
        {orgs.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No organizations yet. Create one above to get started.
          </div>
        ) : (
          orgs.map((org) => {
            const role = memberships.get(org.id) || 'member';
            const isActive = org.id === activeOrgId;
            const isOwner = role === 'owner';

            return (
              <div key={org.id} className="settings-row" data-testid={`org-item-${org.id}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Building2 className="icon-base shrink-0 text-muted-foreground" />
                    <p className="truncate text-sm font-medium text-foreground">{org.name}</p>
                    <Badge variant="secondary" className="text-xs">
                      {role}
                    </Badge>
                    {isActive && (
                      <Badge
                        variant="secondary"
                        className="bg-green-500/15 text-green-700 dark:text-green-400"
                      >
                        Active
                      </Badge>
                    )}
                  </div>
                  <p className="ml-6 text-xs text-muted-foreground">{org.slug}</p>
                </div>
                <div className="flex items-center gap-2">
                  {!isActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSetActive(org.id)}
                      data-testid={`org-set-active-${org.id}`}
                    >
                      <Check className="icon-sm mr-1.5" />
                      Set Active
                    </Button>
                  )}
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteConfirm(org)}
                      data-testid={`org-delete-${org.id}`}
                    >
                      <Trash2 className="icon-base" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
        title="Delete Organization"
        description={`Are you sure you want to delete "${deleteConfirm?.name}"? This action cannot be undone. All members will lose access.`}
        warning="This will permanently delete the organization and all associated data."
        cancelLabel="Cancel"
        confirmLabel="Delete"
        loading={deleting}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
