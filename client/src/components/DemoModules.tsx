import { Permission, useWorkspaceAccess } from '../lib/WorkspaceAccessContext';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Archive, ArrowDownUp, AtSign, Bell, BookOpen, Bot, CalendarDays, Check, CheckCheck,
  CheckCircle2, ChevronDown, ChevronRight, CircleCheck, CircleHelp, CircleX, Copy,
  Download, Eye, FileClock, FileSpreadsheet, FileText, Filter, Gauge, Grip, Grid2X2,
  Headphones, List, LockKeyhole, Mail, Maximize2, MessageCircleMore,
  MoreHorizontal, MoreVertical, Pause, Pencil, Phone, Play, PlayCircle, Plus, Radio,
  RefreshCw, Reply, Search, Send, Settings, ShieldCheck, SlidersHorizontal, Trash2,
  Upload, UserPlus, UserRound, Users, X, Zap
} from 'lucide-react';
import ChatInbox from './ChatInbox';
import SmartpingComposer from './SmartpingComposer';
import SmartpingConnection from './SmartpingConnection';
import CallLogs from './CallLogs';
import CustomerSegments from './CustomerSegments';
import { api, type Resource, type SmartpingStatus, type User, type Workspace } from '../lib/api';
import { useSectionNavigation } from '../lib/navigation';

type Props = {
  page: string;
  user: User;
  onNavigate: (page: string) => void;
  onNotice: (message: string) => void;
  onOpenModal: (type: string) => void;
};

function useResource<T>(resource: Resource, onNotice: (message: string) => void, pollMs = 0) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const load = () => api.list<T>(resource).then(result => setItems(result.items)).catch(error => onNotice(error.message)).finally(() => setLoading(false));
  useEffect(() => { load(); const refresh = () => load(); const timer = pollMs ? window.setInterval(refresh, pollMs) : undefined; window.addEventListener('waba:data-changed', refresh); return () => { window.removeEventListener('waba:data-changed', refresh); if (timer) window.clearInterval(timer); }; }, [resource, pollMs]);
  return { items, loading, reload: load };
}

function formatDate(value?: string) { return value ? new Date(value).toLocaleDateString() : '-'; }
function downloadFile(fileName: string, content: string, type = 'text/csv;charset=utf-8') { const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type })); const link = document.createElement('a'); link.href = url; link.download = fileName; link.click(); URL.revokeObjectURL(url); }

export default function DemoModule({ page, user, onNavigate, onNotice, onOpenModal }: Props) {
  if (page === 'Inbox') return <ChatInbox user={user} onNotice={onNotice} />;
  if (page === 'Calls') return <CallLogs user={user} onNotice={onNotice} />;
  if (page === 'Contacts') return <CustomerSegments onNotice={onNotice} />;
  if (page === 'Scheduled Broadcasts') return <MongoCampaignsPage onNotice={onNotice} onOpenModal={onOpenModal} statusFilter="Scheduled" />;
  if (page === 'Campaigns') return <BroadcastsPage onNotice={onNotice} onOpenModal={onOpenModal} />;
  if (page === 'Templates') return <TemplatesPage onNotice={onNotice} onOpenModal={onOpenModal} />;
  if (page === 'Meta Ads') return <MetaAdsPage onNotice={onNotice} />;
  if (page === 'Automations') return <BotStudioPage onNotice={onNotice} onOpenModal={onOpenModal} />;
  if (page === 'Analytics') return <ReferenceAnalyticsPage onNotice={onNotice} />;
  if (page === 'Enterprise Analytics') return <EnterpriseAnalyticsPage onNotice={onNotice} />;
  if (page === 'Reports') return <ReportsPage onNotice={onNotice} />;
  if (page === 'Help & support') return <HelpPage onNotice={onNotice} />;
  if (page === 'Settings') return <ReferenceSettingsPage user={user} onNotice={onNotice} />;
  if (page === 'Team') return <TeamManagementPage onNotice={onNotice} />;
  return <EmptyPage page={page} onNavigate={onNavigate} />;
}

function ModuleHeader({ title, description, action, icon, onAction }: { title: string; description: string; action?: string; icon?: React.ReactNode; onAction?: () => void }) {
  return <div className="module-header"><div><h1>{title}</h1><p>{description}</p></div>{action && <button className="new-campaign" onClick={onAction}>{icon || <Plus size={18} />}{action}</button>}</div>;
}

function ToolRow({ value, setValue, placeholder, onNotice }: { value: string; setValue: (v: string) => void; placeholder: string; onNotice: (m: string) => void }) {
  return <div className="module-tools"><div className="module-search"><Search size={17}/><input value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder}/></div><button onClick={() => onNotice('Filters are applied to the current workspace data.')}><Filter size={16}/> Filter</button><button onClick={() => onNotice('Export is available from pages that support downloadable data.')}><Download size={16}/> Export</button></div>;
}

function TemplatesPage({ onNotice, onOpenModal }: { onNotice: (m: string) => void; onOpenModal: (t: string) => void }) {
  const access = useWorkspaceAccess();
  const [configuredTemplate, setConfiguredTemplate] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [channel, setChannel] = useState('All Channels');
  const [status, setStatus] = useState('All status');
  const [category, setCategory] = useState('All categories');
  type TemplateItem = { _id: string; name: string; category: string; language: string; body: string; status: string; createdBy?: { name?: string }; createdAt: string; updatedAt: string; lastUsedAt?: string };
  const { items, loading, reload } = useResource<TemplateItem>('templates', onNotice);
  const rows = items.filter(row => `${row.name} ${row.body}`.toLowerCase().includes(query.toLowerCase()) && (category === 'All categories' || row.category.toUpperCase() === category) && (status === 'All status' || row.status === status));
  return <div className="reference-templates">
    <div className="reference-page-title"><h1>Templates</h1><Permission capability="templates.create"><button onClick={() => onOpenModal('template')}><MessageCircleMore size={20}/> New Template</button></Permission></div>
    <div className="template-filterbar">
      <div className="reference-search"><Search size={21}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search template.."/></div>
      <select value={channel} onChange={e => setChannel(e.target.value)}><option>All Channels</option><option>WhatsApp</option></select>
      <select value={status} onChange={e => setStatus(e.target.value)}><option>All status</option><option>Draft</option><option>Pending</option><option>Approved</option><option>Rejected</option></select>
      <select value={category} onChange={e => setCategory(e.target.value)}><option>All categories</option><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
      <select defaultValue="All agents"><option>All agents</option></select>
      <span className="filter-spacer"/><button className="bare-icon" onClick={() => { reload(); onNotice('Templates refreshed.'); }}><RefreshCw size={22}/></button>
      <button className="view-options" onClick={() => onNotice('View options opened.')}><Eye size={19}/> View Options</button>
      <div className="view-switch"><button onClick={() => onNotice('Grid view selected.')}><Grid2X2 size={20}/></button><button className="active"><List size={20}/></button></div>
    </div>
    <div className="reference-template-table"><div className="rt-row rt-head"><span>Template name <ArrowDownUp size={14}/></span><span>Preview</span><span>WABA</span><span>Status</span><span>Created by</span><span>Created on</span><span>Last updated</span><span>Last used on</span></div>
      {loading ? <DataLoading/> : rows.length === 0 ? <DataEmpty title="No templates found" message="Create a template, then map it to an approved Smartping template."/> : rows.map(row => <button className="rt-row" key={row._id} onClick={() => access.can('integrations.manage') ? setConfiguredTemplate(row._id) : onNotice(row.body)} title={access.can('integrations.manage') ? 'Configure Smartping template' : 'View template message'}><span className="template-name-cell"><b>{row.name}</b><small><i>{row.category.toUpperCase()}</i> {row.language}</small></span><span><em className="message-preview">{row.body}</em></span><span className="waba-cell"><b>Current workspace</b><small><Radio size={14}/> WhatsApp template</small></span><span><i className="approved-badge">Local: {row.status}</i></span><span>{row.createdBy?.name || 'Current user'}</span><span>{formatDate(row.createdAt)}</span><span>{formatDate(row.updatedAt)}</span><span>{formatDate(row.lastUsedAt)}</span></button>)}
    </div>
    {configuredTemplate && <SmartpingComposer templateRecordId={configuredTemplate} onClose={() => setConfiguredTemplate(null)} onNotice={onNotice}/>}
  </div>;
}

function BroadcastsPage({ onNotice, onOpenModal }: { onNotice: (m: string) => void; onOpenModal: (t: string) => void }) {
  type Broadcast = { _id: string; name: string; templateName?: string; audienceSize: number; sent: number; delivered: number; read: number; accepted: number; failed: number; contactIds?: string[]; dispatchKey?: string; status: string; createdAt: string };
  type Member = { _id: string; name: string; phone: string };
  const { items: lists } = useResource<Broadcast>('campaigns', onNotice, 5000);
  const { items: members } = useResource<Member>('contacts', onNotice);
  const [selected, setSelected] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState('');
  const colors = ['lavender','sage','mint','sky','rose','violet','rose','ice','purple'];
  const active = lists.find(list => list._id === selected) || lists[0];
  const recipients = members.filter(member => active?.contactIds?.includes(member._id));
  const percent = (value: number, total: number) => total ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';
  return <div className="broadcast-workspace">
    <aside className="broadcast-lists"><header><b>Broadcast lists</b><span><Search size={21}/><Check size={22}/><MoreVertical size={22}/></span></header><button className="sort-row"><ArrowDownUp size={18}/> Sort by <b>Date created - new to old</b><ChevronDown size={18}/></button>
      <div className="import-actions"><button onClick={() => onNotice('Import customers from the Customers page, then select them for this campaign.')}><FileSpreadsheet size={26}/><span>Excel Import</span></button><button onClick={() => downloadFile('broadcast-import-sample.csv', 'Name,Phone,Email\nCustomer,+919876543210,customer@example.com')}><Download size={24}/><span>Sample File</span></button><Permission capability="contacts.create"><button onClick={() => onOpenModal('contact')}><Zap size={22}/><span>Quick Import</span></button></Permission></div>
      <div className="broadcast-list-items">{lists.map(list => <button className={active?._id === list._id ? 'active' : ''} onClick={() => setSelected(list._id)} key={list._id}><b>{list.name}</b><small>{list.contactIds?.length || 0} Members</small></button>)}</div>
      <Permission capability="campaigns.create"><button className="new-list-button" onClick={() => onOpenModal('campaign')}><Plus size={23}/> New List</button></Permission>
    </aside>
    <section className="broadcast-preview">{active ? <><header><span className="group-avatar"><Users size={23}/></span><span><b>{active.name}</b><small>{active.audienceSize || 0} members</small></span><button onClick={() => onNotice('Access is controlled by workspace roles.')}>Manage Access</button><button onClick={() => onNotice('Use Contacts import to add members.')}><Upload size={20}/> Import</button><ChevronRight size={23}/></header>
      <div className="whatsapp-canvas"><span className="date-chip">{formatDate(active.createdAt)}</span><article className="campaign-message"><p><b>{active.name}</b></p><p>{active.templateName || 'No message template has been assigned to this campaign yet.'}</p><time>{active.status}</time>
        {[[active.accepted || 0,'Accepted by Smartping',percent(active.accepted || 0, active.audienceSize),'accepted'],[active.sent || 0,'Sent to',percent(active.sent || 0, active.audienceSize),'sent'],[active.delivered || 0,'Delivered to',percent(active.delivered || 0, active.audienceSize),'delivered'],[active.read || 0,'Read by',percent(active.read || 0, active.audienceSize),'read'],[active.failed || 0,'Failed',percent(active.failed || 0, active.audienceSize),'failed']].map(metric => <button className={`delivery-row ${metric[3]}`} key={String(metric[1])} onClick={() => onNotice(`${metric[1]}: ${metric[0]} recorded for this campaign.`)}>{metric[3] === 'delivered' || metric[3] === 'read' ? <CheckCheck size={20}/> : metric[3] === 'failed' ? <CircleX size={19}/> : <Check size={20}/>}<span><b>{metric[0]}</b> - {metric[1]} <strong>{metric[2]}</strong></span><ChevronRight size={19}/></button>)}
      </article></div>
      <footer><Permission capability="campaigns.send"><button disabled={Boolean(active.dispatchKey)} onClick={() => setComposerOpen(true)}><Send size={21}/> {active.dispatchKey ? 'Broadcast already dispatched' : 'Send WhatsApp Template'}</button></Permission></footer></> : <DataEmpty title="No broadcast lists" message="Create a campaign to build your first broadcast list."/>}
    </section>
    {composerOpen && active && <SmartpingComposer campaignId={active._id} onClose={() => setComposerOpen(false)} onNotice={onNotice}/>}
    <aside className="member-panel"><div className="member-search"><Search size={21}/><input value={memberQuery} onChange={e => setMemberQuery(e.target.value)} placeholder="Search for members"/></div><div className="members-scroll">{recipients.filter(member => `${member.name} ${member.phone}`.toLowerCase().includes(memberQuery.toLowerCase())).map((member,index) => <button key={member._id} onClick={() => onNotice(`${member.name} selected.`)}><i className={colors[index % colors.length]}>{member.name.slice(0,1).toUpperCase()}</i><span><b>{member.name}</b><small>{member.phone}</small></span></button>)}{recipients.length === 0 && <p className="smartping-empty">No recipients selected. Choose customers when sending this broadcast.</p>}</div><Permission capability="campaigns.send"><button className="add-member" disabled={!active || Boolean(active.dispatchKey)} onClick={() => setComposerOpen(true)}><UserPlus size={20}/> Choose recipients</button></Permission></aside>
  </div>;
}

function MetaAdsPage({ onNotice }: { onNotice: (m: string) => void }) {
  type AdItem = { _id: string; name: string; source: string; status: string; impressions: number; clicks: number; chats: number; costPerChat: number; conversionApi: string; spend: number; createdAt: string };
  const { items, loading } = useResource<AdItem>('ads', onNotice);
  const [tab, setTab] = useState<'doubletick' | 'fetched'>('doubletick');
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('Last 30 Days');
  const days = period === 'Last 7 Days' ? 7 : period === 'Last 90 Days' ? 90 : 30;
  const rows = items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()) && (tab === 'doubletick' ? item.source !== 'Fetched' : item.source === 'Fetched') && new Date(item.createdAt).getTime() >= Date.now() - days * 86400000);
  return <div className="meta-ads-page"><header><h1>Ad Performance</h1><p>Monitor and manage your ad campaigns, track conversions and optimise performance metrics</p><nav><button className={tab === 'doubletick' ? 'active' : ''} onClick={() => setTab('doubletick')}>DoubleTick Ads</button><button className={tab === 'fetched' ? 'active' : ''} onClick={() => setTab('fetched')}>Fetched Ads</button></nav></header>
    <section className="ads-table panel"><div className="ads-tools"><div className="reference-search"><Search size={21}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by ad name"/></div><span/><select value={period} onChange={e => setPeriod(e.target.value)}><option>Last 30 Days</option><option>Last 7 Days</option><option>Last 90 Days</option></select><button onClick={() => onNotice('Connect a Meta provider to configure ad synchronization.')}><Settings size={27}/></button></div>
      <div className="ads-head"><span>Ad</span><span>Status</span><span>Impressions</span><span>Clicks</span><span>Chats</span><span>Cost per Chat</span><span>Conversion API</span><span>Spend</span><span>Actions</span></div>
      {loading ? <DataLoading/> : rows.length === 0 ? <div className="ads-empty">{query ? 'No matching ads found' : 'No ads have been connected yet'}</div> : rows.map(item => <button className="ads-head" key={item._id} onClick={() => onNotice(`${item.name} selected.`)}><span>{item.name}</span><span>{item.status}</span><span>{item.impressions.toLocaleString()}</span><span>{item.clicks.toLocaleString()}</span><span>{item.chats.toLocaleString()}</span><span>₹{item.costPerChat.toFixed(2)}</span><span>{item.conversionApi}</span><span>₹{item.spend.toFixed(2)}</span><MoreHorizontal size={18}/></button>)}
    </section>
  </div>;
}

function BotStudioPage({ onNotice, onOpenModal }: { onNotice: (m: string) => void; onOpenModal: (t: string) => void }) {
  const [query, setQuery] = useState('');
  const [showGuide, setShowGuide] = useState(true);
  type BotItem = { _id: string; name: string; trigger: string; message: string; status: string; runs: number };
  const { items, loading } = useResource<BotItem>('automations', onNotice);
  const bots = items.filter(bot => bot.name.toLowerCase().includes(query.toLowerCase()));
  const toggleBot = async (bot: BotItem) => { if (bot.status !== 'Active') return onNotice('Connect your WhatsApp provider before activating bots.'); try { await api.update('automations', bot._id, { status: 'Inactive' }); window.dispatchEvent(new Event('waba:data-changed')); onNotice(`${bot.name} paused.`); } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to update bot.'); } };
  return <div className="bot-studio-page reference-full-page">
    <header className="bot-studio-header"><h1>Bot Studio <CircleHelp size={20}/></h1><div><button className="text-action" onClick={() => onNotice('Bot learning centre opened.')}><BookOpen size={20}/> Learn about bots</button><button className="outline-reference" onClick={() => onNotice('Bot logs opened.')}><FileClock size={20}/> Bot logs</button><Permission capability="automations.create"><button className="green-reference" onClick={() => onOpenModal('automation')}>Create new bot</button></Permission></div></header>
    <div className="bot-toolbar"><div className="reference-search"><Search size={22}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search bot"/></div><span/><select defaultValue="All Bots"><option>All Bots</option><option>Active bots</option></select><select defaultValue="All Channels"><option>All Channels</option><option>WhatsApp</option></select><select defaultValue="All Agents"><option>All Agents</option></select><select defaultValue="Newest first"><option>Newest first</option><option>Oldest first</option></select></div>
    {showGuide && <section className="bot-guide"><article><div className="bot-video-thumb thumb-drip"><span><Play size={30} fill="currentColor"/></span></div><div><h2>Implementing Drip Campaign Bot</h2><p>Set up a Drip Campaign Bot that sends follow-up template messages in a sequence, spaced out perfectly to engage your...</p><button onClick={() => onNotice('Tutorial video opened.')}><PlayCircle size={21}/> Watch Video</button></div></article><article><div className="bot-video-thumb thumb-ctwa"><span><Play size={30} fill="currentColor"/></span></div><div><h2>Automate CTWA Lead Engagement</h2><p>With DoubleTick WhatsApp API, you can effortlessly send 10 customizable message options to CTWA leads, maximizing...</p><button onClick={() => onNotice('Tutorial video opened.')}><PlayCircle size={21}/> Watch Video</button></div></article><button className="close-guide" onClick={() => setShowGuide(false)}><X size={25}/></button></section>}
    <BotSection title="My Bots" count={String(items.length)}>{loading ? <DataLoading/> : bots.length === 0 ? <DataEmpty title="No bots found" message="Create a bot to automate your customer conversations."/> : <div className="default-bot-list">{bots.map(bot => <article className="workspace-bot-row" key={bot._id}><div><b>{bot.name}</b><span>{bot.status} · {bot.trigger} · {bot.runs || 0} runs</span></div><Permission capability="automations.update"><button onClick={() => toggleBot(bot)}>Pause</button></Permission></article>)}</div>}</BotSection>
  </div>;
}

function BotSection({ title, count, children }: { title: string; count: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return <section className="bot-section"><button className="bot-section-title" onClick={() => setOpen(v => !v)}><ChevronDown className={open ? '' : 'collapsed'} size={21}/><b>{title}</b><i>{count}</i></button>{open && children}</section>;
}

function ReferenceAnalyticsPage({ onNotice }: { onNotice: (m: string) => void }) {
  type Metrics = { pendingReplies: number; averageResponseMs: number | null; conversations: number; inbound: number; outbound: number };
  const [metrics, setMetrics] = useState<Metrics>({ pendingReplies: 0, averageResponseMs: null, conversations: 0, inbound: 0, outbound: 0 });
  useEffect(() => { api.analytics<Metrics>().then(setMetrics).catch(error => onNotice(error.message)); }, []);
  const responseTime = metrics.averageResponseMs === null ? 'No data' : `${Math.floor(metrics.averageResponseMs / 3600000)}h : ${Math.floor((metrics.averageResponseMs % 3600000) / 60000)}m`;
  return <div className="response-analytics reference-full-page"><header><h1>Response metrics</h1><p>See how your team is responding to your customers</p></header><div className="response-cards"><article><h2>Pending Replies with Window Open</h2><div><b>{metrics.pendingReplies}</b><strong>Count</strong></div><footer><span>All Agents</span><span>Current workspace</span></footer></article><article><h2>Response Time</h2><div><b>{responseTime}</b><strong>Average</strong></div><footer><span>All Agents</span><span>All time</span></footer></article></div>
    <header className="charts-heading"><h1>Charts</h1><p>Graphs showing analytics of all conversations</p></header><div className="response-chart-grid"><ResponseChart title="Conversations Open" first={`${metrics.conversations} conversations`} value={metrics.conversations} onNotice={onNotice} tools/><ResponseChart title="Messages Replied" first="All agents" value={metrics.outbound} onNotice={onNotice}/></div>
  </div>;
}

function ResponseChart({ title, first, value, tools, onNotice }: { title: string; first: string; value: number; tools?: boolean; onNotice: (m: string) => void }) {
  return <article className="response-chart"><header><h2>{title}</h2>{tools && <span><Grip size={20}/><Maximize2 size={18}/><Settings size={18}/><Copy size={18}/><Trash2 size={18}/></span>}</header><div className="chart-selects"><select defaultValue={first}><option>{first}</option></select><select defaultValue="Last 7 Days"><option>Last 7 Days</option><option>Last 30 Days</option></select></div><button onClick={() => onNotice(`${title} chart selected.`)}>{value ? `${value.toLocaleString()} recorded` : 'No data to show at the moment'}</button></article>;
}

function EnterpriseAnalyticsPage({ onNotice }: { onNotice: (m: string) => void }) {
  const [tab, setTab] = useState<'dashboards'|'reports'>('dashboards');
  const [query, setQuery] = useState('');
  type DashboardItem = { _id: string; name: string; widgets: number; createdBy?: { name?: string }; createdAt: string; updatedAt: string };
  const { items, loading } = useResource<DashboardItem>('dashboards', onNotice);
  const dashboards = items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
  const createDashboard = async () => { const name = window.prompt('Dashboard name'); if (!name?.trim()) return; try { await api.create('dashboards', { name: name.trim(), widgets: 0 }); window.dispatchEvent(new Event('waba:data-changed')); onNotice('Dashboard created.'); } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to create dashboard.'); } };
  return <div className="enterprise-page reference-full-page"><header><h1>Enterprise Analytics</h1><Permission capability="dashboards.create"><button className="green-reference" onClick={createDashboard}><Plus size={20}/> New Dashboard</button></Permission></header><nav><button className={tab === 'dashboards' ? 'active' : ''} onClick={() => setTab('dashboards')}>Dashboards</button><Permission capability="reports.read"><button className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>Reports</button></Permission></nav><div className="enterprise-tools"><div className="reference-search"><Search size={21}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by dashboard name"/></div><span/><select defaultValue="All agents"><option>All agents</option></select><select defaultValue="Recently Edited"><option>Recently Edited</option><option>Recently Created</option></select></div>
    {tab === 'dashboards' ? <div className="enterprise-table"><div className="enterprise-row head"><span>Name <ArrowDownUp size={14}/></span><span>Created By</span><span>Created On <ArrowDownUp size={14}/></span><span>Last Edited</span><span/></div>{loading ? <DataLoading/> : dashboards.length === 0 ? <DataEmpty title="No dashboards found" message="Create a dashboard to organise your analytics widgets."/> : dashboards.map(item => <button className="enterprise-row" key={item._id} onClick={() => onNotice(`${item.name} dashboard opened.`)}><span><b>{item.name}</b><small>{item.widgets || 0} Widgets</small></span><span>{item.createdBy?.name || 'Current user'}</span><span>{formatDate(item.createdAt)}</span><span>{formatDate(item.updatedAt)}</span><MoreHorizontal size={23}/></button>)}</div> : <ReportsPage onNotice={onNotice}/>} 
  </div>;
}

function ReportsPage({ onNotice }: { onNotice: (m: string) => void }) {
  const access = useWorkspaceAccess();
  type ReportItem = { _id: string; type: string; dateRange: string; status: string; fileName: string; requestedBy?: { name?: string }; createdAt: string };
  const { items: reports, loading } = useResource<ReportItem>('reports', onNotice);
  const downloadReport = async (id: string) => {
    try {
      const report = await api.downloadReport(id);
      const url = URL.createObjectURL(new Blob(['\uFEFF' + report.content], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = report.fileName; link.click(); URL.revokeObjectURL(url);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to download report.'); }
  };
  const requestReport = async (type: string, dateRange: string) => {
    try {
      const result = await api.create<{ _id: string }>('reports', { type, dateRange });
      window.dispatchEvent(new Event('waba:data-changed')); await downloadReport(result.item._id); onNotice('Report generated.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to generate report.'); }
  };
  return <div className="reports-page reference-full-page"><header><h1>Reports</h1><p>{access.can('reports.create') ? 'Generate and download workspace reports.' : 'Download existing reports shared with your workspace.'}</p></header><Permission capability="reports.create"><div className="report-generator"><ReportType icon={<Gauge/>} title="Agent activity" copy="Activity analytics of all agents" onRequest={requestReport}/><ReportType icon={<FileText/>} title="Account summary" copy="Message and contact totals for your workspace" onRequest={requestReport}/></div></Permission><h2 className="history-title">Report history</h2><div className="report-history">{loading ? <DataLoading/> : reports.length === 0 ? <DataEmpty title="No reports requested" message={access.can('reports.create') ? 'Select a date range above to generate your first report.' : 'No reports have been generated for this workspace yet.'}/> : reports.map(report => <div key={report._id}><span className="report-icon"><Gauge size={25}/></span><span><b>{report.fileName}</b><small><CalendarDays size={17}/> Requested on {new Date(report.createdAt).toLocaleString()} <UserRound size={17}/> Requested by {report.requestedBy?.name || 'Current user'}</small></span><i>● &nbsp; {report.status}</i><button aria-label={'Download ' + report.fileName} onClick={() => downloadReport(report._id)}><Download size={21}/></button></div>)}</div></div>;
}

function ReportType({ icon, title, copy, onRequest }: { icon: React.ReactNode; title: string; copy: string; onRequest: (type: string, range: string) => void }) {
  const [range, setRange] = useState('');
  return <article>{icon}<h2>{title}</h2><p>{copy}</p><select value={range} onChange={e => setRange(e.target.value)}><option value="">Select date range</option><option>Last 7 days</option><option>Last 30 days</option></select><button disabled={!range} onClick={() => onRequest(title, range)}>Download CSV</button></article>;
}

function TeamManagementPage({ onNotice }: { onNotice: (m: string) => void }) {
  const access = useWorkspaceAccess();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('All roles');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.currentWorkspace().then(result => setWorkspace(result.workspace)).catch(error => onNotice(error.message)); }, []);
  const people = (workspace?.members || []).filter(member => (member.user.name + ' ' + member.user.email).toLowerCase().includes(query.toLowerCase()) && (roleFilter === 'All roles' || (roleFilter === 'admin' ? ['owner','admin'].includes(member.role) : member.role === roleFilter)));
  const roleName = (role: string) => ['owner','admin'].includes(role) ? 'Business admin' : role === 'agent' ? 'Agent' : 'Needs role assignment';
  const invite = async (event: FormEvent) => {
    event.preventDefault(); if (!access.can('team.manage')) return;
    setBusy(true); setError('');
    try { const result = await api.inviteMember(email.trim(), inviteRole); onNotice(result.message); setInviteOpen(false); setEmail(''); const current = await api.currentWorkspace(); setWorkspace(current.workspace); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to add member.'); }
    finally { setBusy(false); }
  };
  return <div className="workspace-team">
    <ModuleHeader title="Team" description="The people and roles in your WhatsApp workspace." action={access.can('team.manage') ? 'Add team member' : undefined} onAction={() => { setError(''); setInviteOpen(true); }}/>
    <div className="team-role-summary">{['admin','agent'].map(role => <article key={role}><span>{roleName(role)}</span><strong>{(workspace?.members || []).filter(member => role === 'admin' ? ['admin','owner'].includes(member.role) : member.role === role).length}</strong><small>{role === 'admin' ? 'Business and channel management' : 'Customer conversations and daily work'}</small></article>)}</div>
    <div className="role-panel"><div className="team-tools"><div className="reference-search"><Search size={18}/><input aria-label="Search team members" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name or email"/></div><select aria-label="Filter team by role" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option>All roles</option>{['admin','agent'].map(role => <option key={role} value={role}>{roleName(role)}</option>)}</select></div><div className="workspace-team-table"><table><thead><tr><th>Team member</th><th>Email</th><th>Workspace role</th><th>Joined</th></tr></thead><tbody>{people.map(member => <tr key={member.user.id || member.user.email}><td><span className="team-member-name"><i className="avatar-chip purple">{member.user.name.slice(0,2).toUpperCase()}</i><b>{member.user.name}</b></span></td><td>{member.user.email}</td><td><span className="status-tag neutral">{roleName(member.role)}</span></td><td>{formatDate(member.joinedAt)}</td></tr>)}</tbody></table>{!people.length && <p className="role-empty">No team members match your search.</p>}</div></div>
    {inviteOpen && access.can('team.manage') && <div className="modal-backdrop"><form className="demo-modal" role="dialog" aria-modal="true" aria-label="Add team member" onSubmit={invite}><div className="modal-head"><div><h2>Add team member</h2><p>Add an active registered account to this workspace.</p></div><button type="button" aria-label="Close" disabled={busy} onClick={() => setInviteOpen(false)}><X size={20}/></button></div><label>Email address<input type="email" required autoFocus disabled={busy} value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com"/></label><label>Workspace role<select disabled={busy} value={inviteRole} onChange={e => setInviteRole(e.target.value)}><option value="agent">Agent</option><option value="admin">Business admin</option></select></label><p className="role-invite-copy">{inviteRole === 'admin' ? 'Manage the business workspace, broadcasts, team, and channel settings.' : 'Handle customer conversations, contacts, and assigned calls.'} Platform permission overrides still apply.</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" disabled={busy} onClick={() => setInviteOpen(false)}>Cancel</button><button type="submit" className="new-campaign" disabled={busy}>{busy ? 'Adding…' : 'Add member'}</button></div></form></div>}
  </div>;
}
function ReferenceSettingsPage({ user, onNotice }: { user: User; onNotice: (m: string) => void }) {
  const access = useWorkspaceAccess();
  const groups = [
    ['ACCOUNT', [['Your profile', UserRound]]],
    ...(access.can('workspace.manage') ? [['WORKSPACE', [['Workspace settings', Settings]]]] : []),
    ...(access.can('integrations.manage') ? [['WHATSAPP CHANNEL', [['Manage channels', Radio]]]] : []),
  ] as [string, [string, typeof UserRound][]][];
  const settingsKey = `waba_settings_section:${user.id}:${user.workspaceId || ''}`;
  const [active, setActive] = useSectionNavigation(settingsKey, groups.flatMap(group => group[1].map(item => item[0])), 'Your profile', 'settings');
  const [query, setQuery] = useState('');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [smartping, setSmartping] = useState<SmartpingStatus | null>(null);
  useEffect(() => {
    api.currentWorkspace().then(result => setWorkspace(result.workspace)).catch(error => onNotice(error.message));
    api.smartpingStatus().then(setSmartping).catch(error => onNotice(error.message));
  }, []);
  const role = access.role === 'owner' || access.role === 'admin' ? 'Business admin' : 'Agent';
  const channelLabel = smartping?.configured ? (smartping.from || 'Smartping WhatsApp sender') : 'No Smartping sender configured';
  return <div className="reference-settings reference-full-page">
    <aside>
      <div className="settings-search"><Search size={22}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search settings..."/></div>
      <div className="settings-menu">{groups.map(group => { const items = group[1].filter(item => item[0].toLowerCase().includes(query.toLowerCase())); return items.length ? <section key={group[0]}><h3>{group[0]}</h3>{items.map(([label,Icon]) => <button className={active === label ? 'active' : ''} onClick={() => setActive(label)} key={label}><Icon size={20}/><span>{label}</span>{['Block sensitive information','IP Address restrictions','Device management','Pending requests'].includes(label) && <LockKeyhole size={15}/>}</button>)}</section> : null;})}</div>
    </aside>
    <main><header><h1>{active}</h1></header>
      {active === 'Your profile' ? <div className="profile-fields">
        <ProfileField label="Name" value={user.name} onEdit={onNotice}/><ProfileField label="Email" value={user.email} onEdit={onNotice}/>
        <ProfileField label="Business name" value={user.company || workspace?.name || 'Not provided'} muted={!user.company && !workspace?.name} onEdit={onNotice}/><ProfileField label="Account role" value={role} onEdit={onNotice}/>
        <Permission capability="integrations.manage"><div className="profile-channel"><span>Primary Channel</span><div><i><Phone size={24}/></i><b>{channelLabel}<small>{smartping?.configured ? `Smartping sender ${smartping.from}` : 'Configure the Smartping sender in Manage channels'}</small></b><button onClick={() => setActive('Manage channels')}><Pencil size={19}/></button></div></div></Permission>
      </div> : active === 'Workspace settings' ? <WorkspaceSettings workspace={workspace} onSave={setWorkspace} onNotice={onNotice}/> : active === 'Manage channels' ? <SmartpingConnection onNotice={onNotice}/> : <div className="settings-placeholder"><Settings size={35}/><h2>{active}</h2><p>No saved {active.toLowerCase()} configuration exists for this workspace yet.</p></div>}
    </main>
  </div>;
}

function WorkspaceSettings({ workspace, onSave, onNotice }: { workspace: Workspace | null; onSave: (workspace: Workspace) => void; onNotice: (message: string) => void }) {
  const [saving, setSaving] = useState(false);
  if (!workspace) return <DataLoading/>;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true);
    const values = new FormData(event.currentTarget);
    try {
      const result = await api.updateWorkspace({ name: values.get('name'), settings: { timezone: values.get('timezone'), supportEmail: values.get('supportEmail'), businessDescription: values.get('businessDescription') } });
      onSave(result.workspace); onNotice('Workspace settings saved.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to save settings.'); }
    finally { setSaving(false); }
  };
  return <form className="settings-form" onSubmit={submit}><label>Workspace name<input name="name" defaultValue={workspace.name} required maxLength={120}/></label><label>Support email<input name="supportEmail" type="email" defaultValue={workspace.settings?.supportEmail || ''}/></label><label>Timezone<select name="timezone" defaultValue={workspace.settings?.timezone || 'Asia/Kolkata'}>{[...new Set([workspace.settings?.timezone || 'Asia/Kolkata', 'Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London'])].map(zone => <option key={zone}>{zone}</option>)}</select></label><label>Business description<textarea name="businessDescription" defaultValue={workspace.settings?.businessDescription || ''}/></label><button className="green-reference" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button></form>;
}

function ProfileField({ label, value, muted, onEdit }: { label: string; value: string; muted?: boolean; onEdit: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const editable = label === 'Name' || label === 'Business name';
  const save = async () => {
    setSaving(true);
    try { await api.updateProfile({ [label === 'Name' ? 'name' : 'company']: draft }); window.dispatchEvent(new Event('waba:profile-changed')); setEditing(false); onEdit('Profile saved.'); }
    catch (error) { onEdit(error instanceof Error ? error.message : 'Unable to save profile.'); }
    finally { setSaving(false); }
  };
  return <div className="profile-field"><span>{label}</span><div>{editing ? <><input aria-label={label} value={draft} onChange={event => setDraft(event.target.value)}/><button disabled={saving || !draft.trim()} onClick={save}>Save</button><button onClick={() => setEditing(false)}>Cancel</button></> : <><b className={muted ? 'muted' : ''}>{value}</b>{editable && <button aria-label={'Edit ' + label} onClick={() => { setDraft(value); setEditing(true); }}><Pencil size={19}/></button>}</>}</div></div>;
}

function HelpPage({ onNotice }: { onNotice: (m: string) => void }) {
  return <><ModuleHeader title="Help & support" description="Find answers or reach the WABADesk support team." /><div className="help-hero panel"><Headphones size={31}/><h2>How can we help?</h2><div className="module-search"><Search size={18}/><input placeholder="Search help articles..."/></div></div><div className="help-grid">{[['Getting started','Set up your business profile and phone number.'],['Campaign guides','Learn how to launch effective broadcasts.'],['Templates & approvals','Create templates that Meta will approve.'],['API documentation','Connect WABADesk to your own systems.']].map(x=><button className="panel" key={x[0]} onClick={() => onNotice(`${x[0]} article opened.`)}><FileText size={20}/><b>{x[0]}</b><p>{x[1]}</p><ChevronRight size={17}/></button>)}</div><div className="support-banner"><div><h3>Still need help?</h3><p>Configure your support channel before accepting customer requests.</p></div><button onClick={() => onNotice('No support channel is configured for this workspace.')}><MessageCircleMore size={17}/> Chat with support</button></div></>;
}

type StoredContact = { _id: string; name: string; phone: string; email?: string; tags?: string[]; subscribed: boolean; lastActiveAt?: string; createdAt: string };
type StoredCampaign = { _id: string; name: string; category: string; audienceSize: number; sent: number; read: number; status: string; createdAt: string };

function MongoContactsPage({ onNotice, onOpenModal }: { onNotice: (m: string) => void; onOpenModal: (t: string) => void }) {
  const [items, setItems] = useState<StoredContact[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () => api.list<StoredContact>('contacts').then(result => setItems(result.items)).catch(error => onNotice(error.message)).finally(() => setLoading(false));
  useEffect(() => { load(); const refresh = () => load(); window.addEventListener('waba:data-changed', refresh); return () => window.removeEventListener('waba:data-changed', refresh); }, []);
  const filtered = items.filter(contact => `${contact.name} ${contact.phone} ${contact.email || ''}`.toLowerCase().includes(query.toLowerCase()));
  const colors = ['purple','pink','blue','amber','teal'];
  return <><ModuleHeader title="Contacts" description="Persistent contacts stored securely in your MongoDB workspace." action="Add contact" icon={<UserPlus size={18}/>} onAction={() => onOpenModal('contact')} /><div className="module-stats"><MiniStat label="Total contacts" value={String(items.length)} note="In this workspace"/><MiniStat label="Subscribed" value={String(items.filter(item => item.subscribed).length)} note="WhatsApp opt-ins"/><MiniStat label="Tagged contacts" value={String(items.filter(item => item.tags?.length).length)} note="Organized contacts"/></div><div className="panel data-panel"><ToolRow value={query} setValue={setQuery} placeholder="Search name, phone or email..." onNotice={onNotice}/>{loading ? <DataLoading/> : filtered.length === 0 ? <DataEmpty title="No contacts found" message="Add your first contact to start a conversation."/> : <div className="data-table"><div className="table-row table-head"><span>Contact</span><span>Phone</span><span>Tag</span><span>Created</span><span>Status</span></div>{filtered.map((contact,index) => <button className="table-row" key={contact._id} onClick={() => onNotice(`${contact.name}'s stored profile selected.`)}><span className="contact-cell"><i className={`avatar-chip ${colors[index % colors.length]}`}>{contact.name.split(' ').map(v => v[0]).slice(0,2).join('')}</i><b>{contact.name}<small>{contact.email || 'No email'}</small></b></span><span>{contact.phone}</span><span><em>{contact.tags?.[0] || 'Contact'}</em></span><span>{new Date(contact.createdAt).toLocaleDateString()}</span><span className={contact.subscribed ? 'status-good' : ''}><i/> {contact.subscribed ? 'Subscribed' : 'Opted out'}</span></button>)}</div>}</div></>;
}

function MongoCampaignsPage({ onNotice, onOpenModal, statusFilter }: { onNotice: (m: string) => void; onOpenModal: (t: string) => void; statusFilter?: string }) {
  const access = useWorkspaceAccess();
  const [items, setItems] = useState<StoredCampaign[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const load = () => api.list<StoredCampaign>('campaigns').then(result => setItems(result.items)).catch(error => onNotice(error.message)).finally(() => setLoading(false));
  useEffect(() => { load(); const refresh = () => load(); window.addEventListener('waba:data-changed', refresh); return () => window.removeEventListener('waba:data-changed', refresh); }, []);
  const visibleItems = statusFilter ? items.filter(item => item.status === statusFilter) : items;
  const filtered = visibleItems.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
  return <><ModuleHeader title={statusFilter ? `${statusFilter} broadcasts` : 'Campaigns'} description={statusFilter ? 'Broadcasts scheduled for future delivery.' : 'Create and manage campaigns stored in your active workspace.'} action={access.can('campaigns.create') ? 'New campaign' : undefined} onAction={() => onOpenModal('campaign')} /><div className="module-stats"><MiniStat label={statusFilter ? 'Scheduled' : 'Total campaigns'} value={String(visibleItems.length)} note="Current workspace"/><MiniStat label="Messages sent" value={visibleItems.reduce((sum,item) => sum + (item.sent || 0),0).toLocaleString()} note="Persisted totals"/><MiniStat label="Active drafts" value={String(visibleItems.filter(item => item.status === 'Draft').length)} note="Ready to configure"/></div><div className="panel data-panel"><ToolRow value={query} setValue={setQuery} placeholder="Search campaigns..." onNotice={onNotice}/>{loading ? <DataLoading/> : filtered.length === 0 ? <DataEmpty title={`No ${statusFilter?.toLowerCase() || ''} campaigns found`} message="Create a campaign to begin."/> : <div className="data-table campaign-table"><div className="table-row table-head"><span>Campaign</span><span>Audience</span><span>Sent</span><span>Read</span><span>Status</span></div>{filtered.map(item => <button className="table-row" key={item._id} onClick={() => onNotice(`${item.name} campaign selected.`)}><span><b>{item.name}</b><small>{item.category}</small></span><span>{item.audienceSize || 0}</span><span>{item.sent || 0}</span><span>{item.read || 0}</span><span className={`pill ${item.status.toLowerCase()}`}>{item.status}</span></button>)}</div>}</div></>;
}

function DataLoading() { return <div className="data-state"><span className="button-spinner dark-spinner"/><p>Loading workspace data…</p></div>; }
function DataEmpty({ title, message }: { title: string; message: string }) { return <div className="data-state"><FileText size={30}/><b>{title}</b><p>{message}</p></div>; }
function MiniStat({ label, value, note }: { label: string; value: string; note: string }) { return <div className="panel mini-stat"><span>{label}</span><b>{value}</b><small>{note}</small></div>; }
function EmptyPage({ page, onNavigate }: { page: string; onNavigate: (p: string) => void }) { return <div className="panel empty-page"><CheckCircle2 size={36}/><h2>{page}</h2><p>This feature is not configured for this workspace.</p><button className="new-campaign" onClick={() => onNavigate('Overview')}>Back to overview</button></div>; }

export function DemoModal({ type, onClose, onNotice }: { type: string; onClose: () => void; onNotice: (m: string) => void }) {
  const labels: Record<string, { title: string; action: string }> = { campaign: { title: 'Create campaign', action: 'Create campaign' }, contact: { title: 'Add a new contact', action: 'Add contact' }, template: { title: 'Create message template', action: 'Submit template' }, automation: { title: 'Create automation', action: 'Create workflow' } };
  const current = labels[type] || labels.campaign;
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setSaving(true);
    const data = new FormData(e.currentTarget);
    try {
      if (type === 'contact') await api.create('contacts', { name: data.get('name'), phone: data.get('phone'), email: data.get('email'), tags: ['Contact'], subscribed: true, lastActiveAt: new Date().toISOString() });
      else if (type === 'campaign') {
        const status = String(data.get('status') || 'Draft');
        const scheduledAt = data.get('scheduledAt');
        if (status === 'Scheduled' && !scheduledAt) throw new Error('Choose a delivery date for a scheduled campaign.');
        await api.create('campaigns', { name: data.get('name'), category: data.get('category'), status, scheduledAt: scheduledAt || undefined, audienceSize: 0 });
      }
      else if (type === 'template') await api.create('templates', { name: data.get('name'), category: data.get('category'), body: data.get('message'), language: 'English', status: 'Draft' });
      else if (type === 'automation') await api.create('automations', { name: data.get('name'), trigger: data.get('category'), message: data.get('message'), status: 'Inactive', runs: 0 });
      window.dispatchEvent(new Event('waba:data-changed')); onClose(); onNotice(`${current.action} saved.`);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to save data.'); }
    finally { setSaving(false); }
  };
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><form className="demo-modal" role="dialog" aria-modal="true" aria-label={current.title} onSubmit={submit}><div className="modal-head"><div><h2>{current.title}</h2><p>Save this record to your workspace.</p></div><button type="button" onClick={onClose}><X size={20}/></button></div>{type === 'contact' ? <><label>Full name<input name="name" required placeholder="e.g. Priya Mehta"/></label><label>WhatsApp number<input name="phone" required placeholder="+91 98765 43210"/></label><label>Email address<input name="email" type="email" placeholder="priya@company.com"/></label></> : <><label>{type === 'template' ? 'Template name' : type === 'automation' ? 'Workflow name' : 'Campaign name'}<input name="name" required placeholder={type === 'template' ? 'order_update' : type === 'automation' ? 'Welcome new customers' : 'October customer update'}/></label><label>{type === 'automation' ? 'Trigger' : 'Category'}<select name="category"><option>{type === 'automation' ? 'Contact subscribes' : 'Marketing'}</option><option>{type === 'automation' ? 'Incoming message' : 'Utility'}</option></select></label>{type === 'campaign' && <><label>Status<select name="status"><option>Draft</option><option>Scheduled</option></select></label><label>Schedule date and time<input name="scheduledAt" type="datetime-local"/></label></>}{type !== 'campaign' && <label>Message<textarea name="message" required placeholder="Write your message here..."/></label>}</>}<div className="modal-actions"><button type="button" onClick={onClose}>Cancel</button><button className="new-campaign" type="submit" disabled={saving}>{saving ? <span className="button-spinner"/> : <><Check size={17}/>{current.action}</>}</button></div></form></div>;
}
