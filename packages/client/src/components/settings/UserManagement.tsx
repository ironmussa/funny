import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth-store';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface UserEntry {
  id: string;
  name: string;
  username: string;
  email: string;
  role: string;
  createdAt: string;
}

export function UserManagement() {
  const { t } = useTranslation();
  const currentUser = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<UserEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'admin'>('user');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await authClient.admin.listUsers({ query: { limit: 100 } });
      if (res.data?.users) {
        setUsers(res.data.users.map((u: any) => ({
          id: u.id,
          name: u.name || '',
          username: u.username || '',
          email: u.email || '',
          role: u.role || 'user',
          createdAt: u.createdAt || '',
        })));
      }
    } catch (err) {
      console.error('[UserManagement] Failed to list users:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreate = async () => {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setError('');
    setCreating(true);

    try {
      await authClient.admin.createUser({
        email: `${newUsername.trim()}@local.host`,
        password: newPassword,
        name: newDisplayName.trim() || newUsername.trim(),
        role: newRole,
        data: {
          username: newUsername.trim(),
        },
      });
      setShowCreate(false);
      setNewUsername('');
      setNewDisplayName('');
      setNewPassword('');
      setNewRole('user');
      await fetchUsers();
    } catch (err: any) {
      setError(err.message || t('users.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const handleRemove = async (userId: string) => {
    if (userId === currentUser?.id) return;
    try {
      await authClient.admin.removeUser({ userId });
      await fetchUsers();
    } catch (err) {
      console.error('[UserManagement] Failed to remove user:', err);
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">{t('common.loading')}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between px-4 pt-2">
        <h3 className="text-sm font-medium text-foreground">{t('users.title')}</h3>
        <Button size="sm" variant="outline" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? t('common.cancel') : t('users.addUser')}
        </Button>
      </div>

      {showCreate && (
        <div className="mx-4 p-3 rounded-md border border-border space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('users.username')}</label>
            <Input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder={t('users.usernamePlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('users.displayName')}</label>
            <Input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder={t('users.displayNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('users.password')}</label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('users.passwordPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('users.role')}</label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={newRole === 'user' ? 'default' : 'outline'}
                onClick={() => setNewRole('user')}
              >
                {t('users.roleUser')}
              </Button>
              <Button
                size="sm"
                variant={newRole === 'admin' ? 'default' : 'outline'}
                onClick={() => setNewRole('admin')}
              >
                {t('users.roleAdmin')}
              </Button>
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button size="sm" onClick={handleCreate} disabled={creating || !newUsername.trim() || !newPassword.trim()}>
            {creating ? t('users.creating') : t('users.create')}
          </Button>
        </div>
      )}

      <div className="space-y-1 px-4">
        {users.map((user) => (
          <div key={user.id} className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-accent/50">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {user.name || user.username}
                {user.role === 'admin' && (
                  <span className="ml-2 text-xs text-primary font-normal">{t('users.roleAdmin')}</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">@{user.username}</p>
            </div>
            {user.id !== currentUser?.id && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-destructive hover:text-destructive"
                onClick={() => handleRemove(user.id)}
              >
                {t('common.delete')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
