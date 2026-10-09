import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Bell, Bot, ChevronDown, ChevronRight, CircleHelp, Home, LockKeyhole, LogOut, Menu, MessageCircleMore, MessagesSquare, Moon, PanelLeftClose, PanelLeftOpen, Phone, Search, Send, Settings, Sun, Users, Wallet, X } from 'lucide-react';
import { api, type User, type Workspace } from '../lib/api';
import { useSectionNavigation } from '../lib/navigation';
import { can, canOpenPage, resolveMembershipRole, roleLabels, workspacePages, type WorkspaceAccess } from '../lib/workspaceAccess';
import { WorkspaceAccessContext } from '../lib/WorkspaceAccessContext';
import DemoModule, { DemoModal } from '../components/DemoModules';
import RoleOverview, { emptyOverview, type OverviewData } from './RoleOverview';
import { money } from './TestWallet';
import BusinessModule from '../components/BusinessModule';
import BusinessOperations from '../components/BusinessOperations';
import BusinessNotifications from '../components/BusinessNotifications';
import { readWalletCharges, walletActivityLabels } from '../lib/walletEvents';

const groups = [
  { label: 'Workspace', pages: [['Overview', Home, 'Dashboard'], ['Inbox', MessagesSquare, 'Inbox'], ['Calls', Phone, 'Call logs'], ['Contacts', Users, 'Contacts']] },
  { label: 'Engagement', pages: [['Templates', MessageCircleMore, 'Templates'], ['Campaigns', Send, 'Campaigns'], ['Scheduled Broadcasts', Send, 'Scheduled broadcasts'], ['Meta Ads', BarChart3, 'Meta ads'], ['Automations', Bot, 'Automations']] },
  { label: 'Management', pages: [['Team', Users, 'Users & Teams'], ['Reports', BarChart3, 'Reports'], ['Analytics', BarChart3, 'Analytics'], ['Enterprise Analytics', BarChart3, 'Dashboards']] },
  { label: 'Content', pages: [['Quick Replies', MessagesSquare, 'Quick Replies'], ['Tags', Users, 'Tags']] },
  { label: 'Settings', pages: [['Business Settings', Settings, 'Business'], ['WhatsApp Numbers', Phone, 'WhatsApp Numbers'], ['Integrations', Settings, 'Integrations'], ['Security', LockKeyhole, 'Security']] },
  { label: 'Administration', pages: [['Wallet', Wallet, 'Billing'], ['Audit Logs', BarChart3, 'Audit Logs']] },
] as const;

const agentGroups = [
  { label: 'My work', pages: [['Overview', Home, 'My work desk'], ['Inbox', MessagesSquare, 'My inbox'], ['Calls', Phone, 'My call logs'], ['Contacts', Users, 'Customers']] },
  { label: 'Resources', pages: [['Templates', MessageCircleMore, 'Message templates'], ['Quick Replies', MessagesSquare, 'Quick Replies']] },
  { label: 'Account', pages: [['Settings', Settings, 'My profile']] },
] as const;

export default function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [access, setAccess] = useState<WorkspaceAccess>({ role: 'agent', permissions: [], features: [], superadmin: false });
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessError, setAccessError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('waba_sidebar_collapsed') === '1');
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('waba_theme') === 'dark');
  const pages = useMemo(() => accessLoading || accessError ? workspacePages : workspacePages.filter(page => canOpenPage(access, page)), [access, accessLoading, accessError]);
  const fallback = pages.includes('Overview') ? 'Overview' : pages[0] || 'Settings';
  const [activePage, goToPage] = useSectionNavigation('waba_navigation:' + user.id + ':' + (user.workspaceId || '') + ':' + access.role, pages, fallback, 'page', !accessLoading && !accessError);
  const [period, setPeriod] = useState('Last 7 days');
  const [overview, setOverview] = useState<OverviewData>(emptyOverview);
  const [dataLoading, setDataLoading] = useState(true);
  const [dataError, setDataError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState('');
  const [search, setSearch] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletDeduction, setWalletDeduction] = useState<{ amountPaise: number; label: string } | null>(null);
  const [announcements, setAnnouncements] = useState<{ _id: string; title: string; message: string; level: string }[]>([]);
  const showNotice = (message: string) => setNotice(message);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => window.clearTimeout(timer); }, [notice]);
  const loadAccess = async () => {
    setAccessLoading(true); setAccessError('');
    try { const result = await api.currentWorkspace(); const role = resolveMembershipRole(result.membershipRole, result.workspace.members || [], user.id, user.role === 'superadmin'); if (!role) throw new Error('Your workspace membership could not be verified. Restart the WABA server and try again.'); setWorkspace(result.workspace); setAccess({ role, permissions: result.permissions || [], features: result.enabledFeatures || [], customPermissions: result.customPermissions, superadmin: user.role === 'superadmin' }); }
    catch (error) { setAccessError(error instanceof Error ? error.message : 'Unable to load workspace access.'); }
    finally { setAccessLoading(false); }
  };
  useEffect(() => { loadAccess(); const changed = () => loadAccess(); window.addEventListener('waba:access-changed', changed); window.addEventListener('focus', changed); return () => { window.removeEventListener('waba:access-changed', changed); window.removeEventListener('focus', changed); }; }, [user.id, user.workspaceId]);
  const navigate = (page: string) => { if (!canOpenPage(access, page)) return; goToPage(page); setSidebarOpen(false); setProfileOpen(false); setNotificationsOpen(false); setSearch(''); };
  const openModal = (type: string) => { const resource = ({ campaign: 'campaigns', contact: 'contacts', template: 'templates', automation: 'automations' } as Record<string, string>)[type]; if (resource && can(access, resource + '.create')) setModal(type); };
  useEffect(() => { setModal(''); setProfileOpen(false); setNotificationsOpen(false); }, [activePage]);
  useEffect(() => { localStorage.setItem('waba_theme', darkMode ? 'dark' : 'light'); }, [darkMode]);
  useEffect(() => { localStorage.setItem('waba_sidebar_collapsed', sidebarCollapsed ? '1' : '0'); }, [sidebarCollapsed]);
  const canReadOverview = !accessLoading && !accessError && can(access, 'overview.read');
  useEffect(() => {
    if (!canReadOverview) { setOverview(emptyOverview); setDataLoading(false); return; }
    let active = true;
    const load = async () => { setDataLoading(true); setDataError(''); try { const data = await api.overview<OverviewData>(Number(period.split(' ')[1])); if (active) setOverview(data); } catch (error) { if (active) setDataError(error instanceof Error ? error.message : 'Unable to load dashboard.'); } finally { if (active) setDataLoading(false); } };
    load(); window.addEventListener('waba:data-changed', load);
    return () => { active = false; window.removeEventListener('waba:data-changed', load); };
  }, [canReadOverview, period, access.role]);
  const canReadWallet = !accessLoading && !accessError && canOpenPage(access, 'Wallet');
  const walletScope = new URL(window.location.href).searchParams.get('workspace') || user.workspaceId || '';
  useEffect(() => {
    setWalletBalance(null); setWalletDeduction(null); if (!canReadWallet) return;
    let active = true, version = 0, activeWorkspace = walletScope; let deductionTimer: number | undefined;
    const seenCharges = new Set<string>();
    const refresh = async () => { const current = ++version; try { const result = await api.walletSummary(); if (active && version === current) { activeWorkspace = result.wallet.workspace; setWalletBalance(result.wallet.balancePaise); } } catch { /* A wallet error does not block the dashboard. */ } };
    const deducted = (event: Event) => {
      const receipts = readWalletCharges((event as CustomEvent<{ charges: unknown }>).detail?.charges, activeWorkspace).filter(receipt => !seenCharges.has(receipt.entryId));
      if (!active || !receipts.length) return; receipts.forEach(receipt => seenCharges.add(receipt.entryId)); ++version;
      setWalletBalance(receipts[receipts.length - 1].balanceAfterPaise);
      setWalletDeduction({ amountPaise: receipts.reduce((sum, receipt) => sum + receipt.chargedPaise, 0), label: [...new Set(receipts.map(receipt => walletActivityLabels[receipt.activity]))].join(' + ') });
      window.clearTimeout(deductionTimer); deductionTimer = window.setTimeout(() => setWalletDeduction(null), 7000); refresh();
    };
    refresh(); const timer = window.setInterval(refresh, 30000); window.addEventListener('waba:wallet-changed', refresh); window.addEventListener('waba:wallet-charged', deducted);
    return () => { active = false; window.clearInterval(timer); window.clearTimeout(deductionTimer); window.removeEventListener('waba:wallet-changed', refresh); window.removeEventListener('waba:wallet-charged', deducted); };
  }, [canReadWallet, user.id, walletScope]);
  useEffect(() => { if (accessLoading || accessError) return; let active = true; const refresh = () => api.announcements().then(result => { if (active) setAnnouncements(result.items); }).catch(() => {}); refresh(); const timer = window.setInterval(refresh, 60000); return () => { active = false; window.clearInterval(timer); }; }, [accessLoading, accessError]);
  useEffect(() => {
    const close = () => { setProfileOpen(false); setNotificationsOpen(false); setSearch(''); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); setSidebarOpen(false); } };
    const outside = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest('.popover-wrap, .global-search')) close(); };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, []);
  const initials = user.name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const roleLabel = accessLoading ? 'Loading access' : accessError ? 'Access unavailable' : access.superadmin ? 'Superadmin access' : roleLabels[access.role];
  const navigationGroups = access.role === 'agent' && !access.superadmin ? [...agentGroups, ...groups.map(group=>({...group,pages:group.pages.filter(([page])=>!agentGroups.some(item=>item.pages.some(([key])=>key===page)))}))] : groups;
  const dashboardLabel = access.role === 'agent' ? 'My work desk' : access.role === 'supervisor' ? 'Team overview' : 'Business overview';
  return <WorkspaceAccessContext.Provider value={access}><div className={'dashboard-shell workspace-shell workspace-role-' + access.role + ' ' + (darkMode ? 'dark-mode ' : '') + (sidebarCollapsed ? 'nav-collapsed' : '')}>
    {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close menu"/>}
    <aside className={'sidebar sidebar-light ' + (sidebarOpen ? 'open' : '')}>
      <div className="sidebar-brand"><span className="brand-mark small"><MessageCircleMore size={20}/></span><span title={workspace?.name}>{workspace?.name || 'Workspace'}</span><button className="mobile-close" aria-label="Close menu" onClick={() => setSidebarOpen(false)}><X size={20}/></button></div>
      <nav className="reference-nav" aria-label="Workspace navigation">{navigationGroups.map(group => { const entries = accessLoading || accessError ? [] : group.pages.filter(([page]) => pages.includes(page)); return entries.length ? <section className="workspace-nav-group" key={group.label}><p>{group.label === 'Administration' && access.role !== 'admin' && access.role !== 'owner' ? 'Account' : group.label}</p>{entries.map(([page, Icon, label]) => <button key={page} title={label} aria-label={label} aria-current={activePage === page ? 'page' : undefined} className={'nav-item ' + (activePage === page ? 'active' : '')} onClick={() => navigate(page)}><Icon size={18}/><span>{page === 'Overview' ? dashboardLabel : label}</span>{page === 'Inbox' && overview.workload?.awaitingReply ? <i>{overview.workload.awaitingReply}</i> : null}</button>)}</section> : null; })}</nav>
      <div className="sidebar-bottom reference-bottom"><button className="nav-item" title="Help & support" onClick={() => navigate('Help & support')}><CircleHelp size={18}/><span>Help & support</span></button><button className="user-card" title="Account settings" onClick={() => navigate('Settings')}><span className="avatar-chip dark">{initials}</span><span><b>{user.name}</b><small>{roleLabel}</small></span><ChevronRight size={17}/></button></div>
    </aside>
    <main className="dashboard-main"><header className="topbar"><div className="topbar-search-area"><button className="menu-button" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Menu size={22}/></button><button className="sidebar-collapse-toggle topbar-sidebar-toggle" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={19}/> : <PanelLeftClose size={19}/>}</button><div className="workspace-breadcrumb"><span>{workspace?.name || 'Workspace'}</span><ChevronRight size={14}/><b>{activePage === 'Overview' ? 'Dashboard' : activePage}</b></div></div>
      <div className="top-actions"><div className="global-search"><div className="search-box"><Search size={16}/><input aria-label="Search workspace pages" placeholder="Go to a page…" value={search} onChange={e => setSearch(e.target.value)}/></div>{search && <div className="search-results">{pages.filter(page => page.toLowerCase().includes(search.toLowerCase())).map(page => <button key={page} onClick={() => navigate(page)}><span>{page}</span><ChevronRight size={15}/></button>)}{!pages.some(page => page.toLowerCase().includes(search.toLowerCase())) && <p>No matching pages</p>}</div>}</div>
        {canReadWallet && <button className={'topbar-wallet ' + (activePage === 'Wallet' ? 'active' : '')} aria-label="Open test wallet" title="Test credits" onClick={() => navigate('Wallet')}><Wallet size={17}/><b>{walletBalance === null ? '—' : money(walletBalance)}</b></button>}
        <button className="icon-button" aria-label={'Switch to ' + (darkMode ? 'light' : 'dark') + ' mode'} onClick={() => setDarkMode(v => !v)}>{darkMode ? <Sun size={19}/> : <Moon size={19}/>}</button><div className="popover-wrap"><button className="icon-button notification" aria-label="Announcements" aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen(v => !v); setProfileOpen(false); }}><Bell size={19}/>{announcements.length > 0 && <i/>}</button>{notificationsOpen && <div className="top-popover notification-popover"><div><b>Notifications</b></div>{announcements.length ? announcements.map(item => <div key={item._id}><b>{item.title}</b><p>{item.message}</p></div>) : <p>No platform announcements.</p>}<BusinessNotifications admin={access.superadmin || ['admin','owner'].includes(access.role)} onNavigate={navigate}/></div>}</div>
        <div className="popover-wrap"><button className="top-user" aria-label="Account menu" aria-expanded={profileOpen} onClick={() => { setProfileOpen(v => !v); setNotificationsOpen(false); }}><span className="avatar-chip dark">{initials}</span><ChevronDown size={14}/></button>{profileOpen && <div className="top-popover profile-popover"><div><b>{user.name}</b><small>{user.email}</small><small>{roleLabel}</small></div><button onClick={() => navigate('Settings')}><Settings size={16}/> Account settings</button><button onClick={onLogout}><LogOut size={16}/> Sign out</button></div>}</div>
      </div></header>
      <div className="dashboard-content">{accessLoading ? <div className="data-state"><span className="button-spinner dark-spinner"/><p>Loading your workspace…</p></div> : accessError ? <div className="panel access-error" role="alert"><LockKeyhole size={28}/><h2>Unable to open workspace</h2><p>{accessError}</p><button className="new-campaign" onClick={loadAccess}>Try again</button><button className="secondary-button" onClick={onLogout}>Sign out</button></div> : <>{announcements.map(item => <article className={'workspace-announcement ' + item.level.toLowerCase()} key={item._id}><Bell size={18}/><div><b>{item.title}</b><p>{item.message}</p></div></article>)}{!canOpenPage(access, activePage) ? <div className="data-state"><LockKeyhole size={28}/><b>This page is unavailable for your role.</b></div> : activePage === 'Overview' ? <RoleOverview data={overview} loading={dataLoading} error={dataError} user={user} workspace={workspace} period={period} setPeriod={setPeriod} navigate={navigate} openModal={openModal} onNotice={showNotice}/> : ['Contacts','Quick Replies','Tags','Team','Reports','Wallet','Audit Logs'].includes(activePage) ? <BusinessModule page={activePage} user={user} onNotice={showNotice} onNavigate={navigate}/> : ['Business Settings','WhatsApp Numbers','Integrations','Security','Campaigns','Automations','Templates'].includes(activePage) ? <BusinessOperations page={activePage} user={user} onNotice={showNotice} onNavigate={navigate}/> : <DemoModule page={activePage} user={user} onNavigate={navigate} onNotice={showNotice} onOpenModal={openModal}/>}</>}</div>
    </main>{notice && <div className="toast" role="status">{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15}/></button></div>}{walletDeduction && <div className="wallet-charge-toast" role="status"><Wallet size={22}/><div><b>{money(walletDeduction.amountPaise)} deducted</b><span>{walletDeduction.label} · Test wallet</span></div></div>}{modal && <DemoModal type={modal} onClose={() => setModal('')} onNotice={showNotice}/>}</div></WorkspaceAccessContext.Provider>;
}
