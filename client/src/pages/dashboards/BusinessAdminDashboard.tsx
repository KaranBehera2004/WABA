import { useEffect, useState } from 'react';
import { ArrowUpRight, CheckCheck, FileText, MessageCircleMore, Plus, Send, Settings, ShieldCheck, Users } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, type SmartpingStatus } from '../../lib/api';
import { useWorkspaceAccess } from '../../lib/WorkspaceAccessContext';
import type { DashboardProps } from '../RoleOverview';
import { CampaignTable, count, openInbox, PanelHeading, PeriodSelect, ratio, type CampaignResult } from './shared';

export default function BusinessAdminDashboard({ data, loading, error, workspace, period, setPeriod, navigate, openModal }: DashboardProps) {
  const access = useWorkspaceAccess();
  const [channel, setChannel] = useState<SmartpingStatus | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignResult[]>([]);
  const [campaignLoading, setCampaignLoading] = useState(true);
  const [campaignError, setCampaignError] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (access.can('integrations.manage')) api.smartpingStatus().then(result => { if (active) setChannel(result); }).catch(() => {});
      if (!access.can('campaigns.read')) { setCampaignLoading(false); return; }
      setCampaignLoading(true); setCampaignError('');
      api.list<CampaignResult>('campaigns').then(result => { if (active) setCampaigns(result.items); }).catch(error => { if (active) setCampaignError(error.message); }).finally(() => { if (active) setCampaignLoading(false); });
    };
    refresh(); window.addEventListener('waba:data-changed', refresh);
    return () => { active = false; window.removeEventListener('waba:data-changed', refresh); };
  }, [access.permissions, access.features]);
  const canAnalyze = access.can('analytics.read') && access.can('conversations.read');
  const members = (workspace?.members || []).filter(member => ['owner','admin','agent'].includes(member.role));
  const memberCount = (role: string) => members.filter(member => role === 'admin' ? ['owner', 'admin'].includes(member.role) : member.role === role).length;
  const settings = () => { const url = new URL(window.location.href); url.searchParams.set('settings', 'Manage channels'); window.history.replaceState(null, '', url); navigate('Settings'); };
  return <div className="role-overview role-admin business-dashboard" data-dashboard="business-admin">
    <div className="role-heading"><div><div className="role-eyebrow"><span>Business admin · Management workspace</span></div><h1>Business overview</h1><p>Manage your channel, campaigns, and the people serving your customers.</p></div><div className="heading-actions">{canAnalyze && <PeriodSelect period={period} setPeriod={setPeriod}/>} {access.can('campaigns.create') && <button className="new-campaign" onClick={() => openModal('campaign')}><Plus size={17}/> Create campaign</button>}</div></div>
    {error && <div className="admin-error" role="alert">{error}</div>}
    <section className="business-command-strip" aria-label="Business actions">
      {access.can('contacts.create') && <button onClick={() => openModal('contact')}><Users size={19}/><span><b>Add customer</b><small>Grow your contact base</small></span><ArrowUpRight size={16}/></button>}
      {access.can('team.read') && <button onClick={() => navigate('Team')}><ShieldCheck size={19}/><span><b>Manage team</b><small>Roles and workspace access</small></span><ArrowUpRight size={16}/></button>}
      {access.can('templates.create') && <button onClick={() => openModal('template')}><FileText size={19}/><span><b>Create template</b><small>Prepare your next message</small></span><ArrowUpRight size={16}/></button>}
      {access.can('integrations.manage') && <button onClick={settings}><Settings size={19}/><span><b>Channel setup</b><small>Provider and delivery tracking</small></span><ArrowUpRight size={16}/></button>}
    </section>
    {!error && <section className="role-metrics" aria-label="Business totals">
      {access.can('contacts.read') && <button className="role-metric" onClick={() => navigate('Contacts')}><div><span className="role-metric-icon purple"><Users size={20}/></span><ArrowUpRight size={16}/></div><span>Customer base</span><strong>{count(data.metrics.contacts, loading)}</strong><small>All workspace customers</small></button>}
      {access.can('conversations.read') && <button className="role-metric" onClick={() => openInbox(navigate, 'all:All')}><div><span className="role-metric-icon green"><MessageCircleMore size={20}/></span><ArrowUpRight size={16}/></div><span>Customer conversations</span><strong>{count(data.metrics.conversations, loading)}</strong><small>All-time workspace total</small></button>}
      {canAnalyze && <><button className="role-metric" onClick={() => navigate('Analytics')}><div><span className="role-metric-icon blue"><Send size={20}/></span><ArrowUpRight size={16}/></div><span>Messages sent</span><strong>{count(data.metrics.sent, loading)}</strong><small>{period} · recorded sent events</small></button><button className="role-metric" onClick={() => navigate('Analytics')}><div><span className="role-metric-icon orange"><CheckCheck size={20}/></span><ArrowUpRight size={16}/></div><span>Delivery rate</span><strong>{loading ? '—' : ratio(data.metrics.delivered, data.metrics.sent) + '%'}</strong><small>{count(data.metrics.delivered, loading)} delivered · selected period</small></button></>}
    </section>}
    <div className="business-management-grid">
      <div className="business-main-column">
        {canAnalyze && !error && <section className="role-panel performance-panel"><PanelHeading title="Channel performance" description={'Workspace message delivery · ' + period.toLowerCase()}/><div className="role-chart-legend"><span><i className="sent"/>Sent <b>{count(data.metrics.sent, loading)}</b></span><span><i className="delivered"/>Delivered <b>{count(data.metrics.delivered, loading)}</b></span><span><i className="read"/>Read <b>{count(data.metrics.read, loading)}</b></span></div>{loading ? <p className="role-empty">Loading channel performance…</p> : !data.metrics.sent ? <div className="dashboard-empty-chart"><Send size={32}/><b>Your channel activity starts here</b><p>Recorded message events will populate this chart.</p></div> : <div className="role-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.chart} margin={{top:10,right:10,left:-20,bottom:0}}><CartesianGrid strokeDasharray="3 4" vertical={false} stroke="var(--ui-border)"/><XAxis dataKey="day" axisLine={false} tickLine={false} minTickGap={30} tick={{fill:'var(--ui-muted)',fontSize:11}}/><YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{fill:'var(--ui-muted)',fontSize:11}}/><Tooltip contentStyle={{background:'var(--ui-surface)',border:'1px solid var(--ui-border)',borderRadius:10}}/><Area isAnimationActive={false} dataKey="sent" stroke="#159b78" fill="#159b78" fillOpacity={0.1}/><Area isAnimationActive={false} dataKey="delivered" stroke="#5d82d8" fill="transparent"/><Area isAnimationActive={false} dataKey="read" stroke="#a586d4" fill="transparent"/></AreaChart></ResponsiveContainer></div>}</section>}
        {access.can('campaigns.read') && <section className="role-panel"><PanelHeading title="Campaign monitor" description="Recent broadcasts · recorded provider totals" action={() => navigate('Campaigns')}/><CampaignTable items={campaigns.slice(0,5)} loading={campaignLoading} error={campaignError} onOpen={() => navigate('Campaigns')}/>{access.can('campaigns.read') && <button className="role-footer-link" onClick={() => navigate('Campaigns')}><Send size={16}/> Manage broadcasts</button>}</section>}
        {access.can('conversations.read') && access.can('contacts.read') && !error && <section className="role-panel"><PanelHeading title="Recent customer activity" description="Interactions across the whole workspace" action={() => openInbox(navigate,'all:All')}/><div className="role-conversation-list">{loading ? <p className="role-empty">Loading conversations…</p> : !data.recentConversations.length ? <p className="role-empty">No customer conversations yet.</p> : data.recentConversations.map(item => <button key={item._id} onClick={() => openInbox(navigate,'all:All',item._id)}><span className="avatar-chip purple">{(item.contact?.name || '?').slice(0,2)}</span><span><b>{item.contact?.name || item.contact?.phone || 'Unknown contact'}</b><small>{item.lastMessage || 'No messages yet'}</small></span><span className="status-tag neutral">{item.status.replace(/_/g,' ')}</span></button>)}</div></section>}
      </div>
      <aside className="business-side-column" aria-label="Business management">
        {access.can('team.read') && <section className="role-panel"><PanelHeading title="Your workspace team" description="Seats by business responsibility"/><div className="business-team-total"><Users size={24}/><strong>{members.length}</strong><span>workspace members</span></div><div className="team-role-breakdown">{[['admin','Business admins','Manage business'],['agent','Agents','Serve customers']].map(([role,label,description]) => <div key={role}><span className={'team-role-dot ' + role}/><span><b>{label}</b><small>{description}</small></span><strong>{memberCount(role)}</strong></div>)}</div><button className="role-footer-link" onClick={() => navigate('Team')}>Manage members & roles <ArrowUpRight size={16}/></button></section>}
        {access.can('integrations.manage') && <section className="role-panel"><PanelHeading title="Channel health" description="Your WhatsApp provider configuration"/><div className="readiness-list"><div><span>WhatsApp provider</span><b className={'status-tag ' + (channel?.configured ? 'success' : 'warning')}>{!channel ? 'Not verified' : channel.configured ? 'Configured' : 'Setup required'}</b></div><div><span>Delivery tracking</span><b className="status-tag neutral">{!channel ? 'Not verified' : channel.deliveryTracking ? 'Configured' : 'Setup required'}</b></div></div><button className="role-footer-link" onClick={settings}><Settings size={16}/> Configure channel</button></section>}
        {access.can('templates.read') && !error && <section className="role-panel"><PanelHeading title="Template readiness" description="Latest saved message templates" action={() => navigate('Templates')}/><div className="business-template-list">{loading ? <p className="role-empty">Loading templates…</p> : !data.templates.length ? <p className="role-empty">No templates saved yet.</p> : data.templates.map(item => <button key={item._id} onClick={() => navigate('Templates')}><FileText size={17}/><span><b>{item.name}</b><small>{item.category}</small></span><span className="status-tag neutral">{item.status}</span></button>)}</div></section>}
      </aside>
    </div>
  </div>;
}
