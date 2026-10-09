import { useState } from 'react';
import { ArrowUpRight, CheckCheck, Clock3, Headphones, MessageCircleMore, Plus, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { useWorkspaceAccess } from '../../lib/WorkspaceAccessContext';
import type { Conversation, DashboardProps } from '../RoleOverview';
import { count, openInbox, PanelHeading } from './shared';
import AgentAvailability from '../../components/AgentAvailability';
import { FormDialog } from '../../components/BusinessModule';

export default function AgentDashboard({ data, loading, error, user, navigate, openModal, onNotice }: DashboardProps) {
  const access = useWorkspaceAccess();
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [resolution, setResolution] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const queue = data.workload?.queue || [];
  const awaiting = queue.filter(item => item.status === 'awaiting_reply');
  const open = queue.filter(item => item.status === 'open');
  const canSeeQueue = access.can('conversations.read') && access.can('contacts.read');
  const closeConversation = async (id: string) => {
    if (!access.can('conversations.update') || busy) return;
    setBusy(id); setActionError('');
    try { const result=await api.currentWorkspace(); setReasons((result.workspace.settings as any)?.resolutionReasons||['Question answered','Issue resolved','No response','Other']);setResolution(id); }
    catch (error) { setActionError(error instanceof Error ? error.message : 'Unable to resolve this conversation.'); }
    finally { setBusy(''); }
  };
  const card = (item: Conversation) => <article className="agent-task" key={item._id}>
    <div className="agent-task-customer"><span className="avatar-chip purple">{(item.contact?.name || '?').slice(0,2).toUpperCase()}</span><div><b>{item.contact?.name || item.contact?.phone || 'Unknown contact'}</b><small>{item.contact?.phone || 'Assigned to you'}</small></div></div>
    <p>{item.lastMessage || 'Open this conversation to review customer messages.'}</p>
    <small className="agent-task-time">{item.lastMessageAt ? new Date(item.lastMessageAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : 'No message timestamp'}</small>
    <div className="agent-task-actions"><button className="secondary-button" onClick={() => openInbox(navigate, 'mine:All', item._id)}><MessageCircleMore size={15}/> {item.status === 'awaiting_reply' ? 'Open & reply' : 'Open conversation'}</button>{access.can('conversations.update') && <button aria-label={'Resolve conversation with ' + (item.contact?.name || item.contact?.phone || 'customer')} disabled={Boolean(busy)} onClick={() => closeConversation(item._id)}><CheckCheck size={16}/> {busy === item._id ? 'Saving…' : 'Resolve'}</button>}</div>
  </article>;
  return <div className="role-overview role-agent agent-dashboard" data-dashboard="agent">
    <div className="role-heading"><div><div className="role-eyebrow"><span>Agent · Personal workspace</span></div><h1>My work desk</h1><p>Welcome, {user.name.split(' ')[0]}. Focus on your assigned customers and the next reply.</p></div><div className="heading-actions">{access.can('conversations.read') && <button className="new-campaign" onClick={() => openInbox(navigate, 'mine:All')}><Headphones size={17}/> Open my inbox</button>}</div></div>
    {error && <div className="admin-error" role="alert">{error}</div>}{actionError && <div className="admin-error" role="alert">{actionError}</div>}
    <div className="agent-shift-summary" aria-label="My assigned workload">
      {access.can('conversations.read') && <><button onClick={() => openInbox(navigate,'mine:Awaiting reply')}><span className="agent-summary-icon orange"><Clock3 size={19}/></span><span><strong>{count(data.workload?.awaitingReply,loading || Boolean(error))}</strong><small>Awaiting my reply</small></span></button><button onClick={() => openInbox(navigate,'mine:Open')}><span className="agent-summary-icon blue"><MessageCircleMore size={19}/></span><span><strong>{count(data.workload?.open,loading || Boolean(error))}</strong><small>My open conversations</small></span></button><button onClick={() => openInbox(navigate,'mine:Closed')}><span className="agent-summary-icon green"><CheckCheck size={19}/></span><span><strong>{count(data.workload?.closed,loading || Boolean(error))}</strong><small>Resolved by me</small></span></button></>}
      {access.can('calls.read') && <button onClick={() => navigate('Calls')}><span className="agent-summary-icon purple"><Headphones size={19}/></span><span><strong>{count(data.workload?.callbacks,loading || Boolean(error))}</strong><small>My pending callbacks</small></span></button>}
    </div>
    <div className="agent-desk-grid">
      <section className="agent-workboard" aria-label="My conversation workboard">
        <div className="agent-board-heading"><div><h2>My conversation workboard</h2><p>Your latest 25 unresolved conversations · counts cover all assigned records</p></div><span className="role-access-badge"><Headphones size={15}/> Assigned to me</span></div>
        {error ? <p className="role-empty">Your conversation queue could not be loaded.</p> : !canSeeQueue ? <p className="role-empty">Your current permissions do not include conversation details.</p> : <div className="agent-board-columns">
          <div className="agent-board-column awaiting"><header><span><i/>Needs my reply</span><b>{count(data.workload?.awaitingReply,loading || Boolean(error))}</b></header>{loading ? <p className="role-empty">Loading your queue…</p> : awaiting.length ? awaiting.map(card) : <div className="agent-board-empty"><CheckCheck size={28}/><b>Replies up to date</b><p>No awaiting-reply conversations in your latest queue.</p></div>}</div>
          <div className="agent-board-column active"><header><span><i/>In progress</span><b>{count(data.workload?.open,loading || Boolean(error))}</b></header>{loading ? <p className="role-empty">Loading your queue…</p> : open.length ? open.map(card) : <div className="agent-board-empty"><MessageCircleMore size={28}/><b>No active conversations</b><p>Your assigned open conversations will appear here.</p></div>}</div>
        </div>}
      </section>
      <aside className="agent-desk-side" aria-label="Agent daily activities">
        <AgentAvailability onNotice={onNotice}/>
        {access.can('conversations.claim') && <section className="role-panel agent-shared-queue"><PanelHeading title="Shared queue" description="Unassigned customer conversations"/><div className="agent-unassigned-total"><strong>{count(data.workload?.unassigned,loading || Boolean(error))}</strong><span>conversations waiting for an agent</span></div>{canSeeQueue && !error && <div className="agent-unassigned-list">{(data.workload?.unassignedQueue || []).slice(0,4).map(item => <button key={item._id} onClick={() => openInbox(navigate,'unassigned:All',item._id)}><span><b>{item.contact?.name || item.contact?.phone || 'Unknown contact'}</b><small>{item.lastMessage || 'View conversation'}</small></span><ArrowUpRight size={16}/></button>)}</div>}<button className="role-footer-link" onClick={() => openInbox(navigate,'unassigned:All')}>Review shared queue <ArrowUpRight size={16}/></button></section>}
        {access.can('calls.read') && <section className="agent-callback-card"><Headphones size={24}/><h2>Follow up with customers</h2><p>{count(data.workload?.callbacks,loading || Boolean(error))} assigned call records have pending callbacks.</p><button className="secondary-button" onClick={() => navigate('Calls')}>Review my callbacks <ArrowUpRight size={16}/></button></section>}
        <section className="role-panel"><PanelHeading title="Daily tools" description="Customer service essentials"/><div className="agent-tools">{access.can('contacts.create') && <button onClick={() => openModal('contact')}><Plus size={18}/> Add a customer <ArrowUpRight size={15}/></button>}{access.can('contacts.read') && <button onClick={() => navigate('Contacts')}><Users size={18}/> Customer directory <ArrowUpRight size={15}/></button>}{access.can('templates.read') && <button onClick={() => navigate('Templates')}><MessageCircleMore size={18}/> Message templates <ArrowUpRight size={15}/></button>}</div></section>
      </aside>
    </div>
    {resolution && <FormDialog title="Resolve conversation" fields={[{key:'resolutionReason',label:'Resolution reason',type:'select',required:true,options:reasons.map(value=>({value,label:value}))}]} onClose={()=>setResolution('')} onSave={async values=>{await api.update('conversations',resolution,{status:'closed',resolutionReason:values.resolutionReason});window.dispatchEvent(new Event('waba:data-changed'));onNotice('Conversation resolved.');}}/>}
  </div>;
}
