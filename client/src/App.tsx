import { useEffect, useState } from 'react';
import type { User } from './lib/api';
import { api, defaultPublicPlatform, type PublicPlatformInfo } from './lib/api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import SuperAdmin from './pages/SuperAdmin';
import InvitationSetup from './components/InvitationSetup';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<PublicPlatformInfo>(defaultPublicPlatform);
  useEffect(() => {
    const refresh = () => { api.platformInfo().then(result => setPlatform({ ...defaultPublicPlatform, ...result })).catch(() => {}); };
    refresh(); window.addEventListener('waba:platform-changed', refresh);
    return () => window.removeEventListener('waba:platform-changed', refresh);
  }, []);
  const [adminWorkspace, setAdminWorkspace] = useState(() => new URL(window.location.href).searchParams.get('workspace'));
  useEffect(() => {
    const restore = () => setAdminWorkspace(new URL(window.location.href).searchParams.get('workspace'));
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const openWorkspace = (id: string | null) => {
    const url = new URL(window.location.href);
    url.searchParams.delete('settings'); url.searchParams.delete('page');
    if (id) { url.searchParams.set('workspace', id); url.searchParams.set('page', 'Overview'); }
    else url.searchParams.delete('workspace');
    window.history.pushState(window.history.state, '', url); setAdminWorkspace(id);
  };
  useEffect(() => {
    const refresh = () => { api.me().then(result => setUser(result.user)).catch(() => {}); };
    window.addEventListener('waba:profile-changed', refresh);
    return () => window.removeEventListener('waba:profile-changed', refresh);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('waba_token');
    if (!token) return setLoading(false);
    api.me()
      .then(({ user }) => setUser(user))
      .catch(() => localStorage.removeItem('waba_token'))
      .finally(() => setLoading(false));
  }, []);

  const logout = () => {
    localStorage.removeItem('waba_token');
    const url = new URL(window.location.href); url.search = ''; window.history.replaceState(null, '', url); setAdminWorkspace(null);
    setUser(null);
  };
  useEffect(() => { window.addEventListener('waba:session-expired', logout); return () => window.removeEventListener('waba:session-expired', logout); }, []);
  const login = (account: User) => {
    if (account.role !== 'superadmin') {
      const url = new URL(window.location.href);
      for (const key of ['workspace', 'admin', 'page', 'settings']) url.searchParams.delete(key);
      url.searchParams.set('page', 'Overview');
      window.history.replaceState(null, '', url); setAdminWorkspace(null);
    }
    setUser(account);
  };

  const invitation = new URL(window.location.href).searchParams.get('invitation');
  if (invitation) return <InvitationSetup token={invitation}/>;
  if (loading) {
    return <div className="app-loader"><div className="brand-mark small"><span>W</span></div><div className="loader-line" /></div>;
  }
  if (user?.role === 'superadmin') return adminWorkspace ? <><div className="admin-workspace-banner"><span>Superadmin workspace access</span><button onClick={() => openWorkspace(null)}>Return to superadmin</button></div><Dashboard key={adminWorkspace} user={{ ...user, workspaceId: adminWorkspace }} onLogout={logout}/></> : <SuperAdmin user={user} onLogout={logout} onOpenWorkspace={openWorkspace} platformName={platform.platformName}/>;
  return user ? <Dashboard user={user} onLogout={logout}/> : <Login onLogin={login} platform={platform}/>;
}
