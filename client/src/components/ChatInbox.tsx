import { Permission, useWorkspaceAccess } from '../lib/WorkspaceAccessContext';
import { useEffect, useState } from 'react';
import {
  Archive, ArrowDownUp, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3,
  Image as ImageIcon, MessageCircleMore, MoreVertical, Plus, Search, Send,
  SlidersHorizontal, UserCircle, UserPlus, UserRoundX, Users
} from 'lucide-react';
import { api, businessApi, type User } from '../lib/api';

import SmartpingComposer from './SmartpingComposer';
import ConversationTools from './ConversationTools';

type Chat = { assignedTo?: string; contact?: any; team?: string; number?: string; tags?: string[]; version?: number; humanTakeover?: boolean; resolutionReason?: string; owner?: string; status: string; channel: string; updated: string; id?: string; name: string; initials: string; color: string; message: string; time: string; unread: number; tag: string; stage: string; type: string };
type StoredMessage = { _id: string; direction: 'inbound' | 'outbound'; body: string; createdAt: string; status: string; error?: { message?: string } };

export default function ChatInbox({ user, onNotice }: { user: User; onNotice: (message: string) => void }) {
  const access = useWorkspaceAccess();
  const [selected, setSelected] = useState<string | null>(() => new URL(window.location.href).searchParams.get('conversation'));
  const [composerOpen, setComposerOpen] = useState(false);
  const [memberFilter, setMemberFilter] = useState('all');
  const [stage, setStage] = useState('All');
  const [inboxFilter, setInboxFilter] = useState(() => { const requested = new URL(window.location.href).searchParams.get('inbox'); return requested && /^(all|mine|unassigned|team):(All|Open|Closed|Awaiting reply|Unread|Pending|Resolved)$/.test(requested) ? requested : access.role === 'agent' ? 'mine:All' : 'all:All'; });
  const [tagFilter, setTagFilter] = useState('All tags');
  const [channelFilter, setChannelFilter] = useState('All channels');
  const [dateFilter, setDateFilter] = useState('All time');
  const [view, setView] = useState<'chats' | 'groups'>('chats');
  const [query, setQuery] = useState('');
  const [sortNewest, setSortNewest] = useState(true);
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [storedChats, setStoredChats] = useState<Chat[]>([]);
  const [offset,setOffset]=useState(0),[total,setTotal]=useState(0),[teamFilter,setTeamFilter]=useState(''),[numberFilter,setNumberFilter]=useState(new URL(location.href).searchParams.get('number')||''),[filterOptions,setFilterOptions]=useState<{users:any[];teams:any[];numbers:any[]}>({users:[],teams:[],numbers:[]});
  useEffect(()=>{businessApi.get<any>('/me/inbox-options').then(setFilterOptions).catch(error=>onNotice(error.message));},[]);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const stages = ['All', 'New Lead', 'Contacted', 'Responded', 'Follow-Up Required', 'Walk-In Scheduled', 'Walk-In Completed', 'Negotiation', 'Payment Link Sent'];
  const load = () => api.conversations<any>({stage:stage==='All'?'':stage,limit:'50',offset:String(offset),team:teamFilter,number:numberFilter,tag:tagFilter==='All tags'?'':tagFilter,...(dateFilter==='All time'?{}:{from:new Date(dateFilter==='Today'?new Date().setHours(0,0,0,0):Date.now()-(dateFilter==='Last 7 days'?7:30)*86400000).toISOString()}),queue:inboxFilter.split(':')[0],...(inboxFilter.split(':')[1] === 'Unread' ? {unread:'true'} : inboxFilter.split(':')[1] !== 'All' ? {status:inboxFilter.split(':')[1]} : {}),...(memberFilter !== 'all' ? {assignedTo:memberFilter} : {}),q:query,...Object.fromEntries(['from','to','unread'].map(key=>[key,new URL(location.href).searchParams.get(key)||'']).filter(([,value])=>value))}).then(result => {setTotal(result.total);setStoredChats(result.items.map((item: any, index: number) => ({ id: item._id, contact:item.contact, team:item.team, number:item.number, tags:item.tags, version:item.version, humanTakeover:item.humanTakeover, resolutionReason:item.resolutionReason, assignedTo: item.assignedTo?._id, owner: item.assignedTo?.name, status: item.status, channel: item.channel, updated: item.lastMessageAt || item.createdAt, name: item.contact?.name || 'Unknown contact', initials: (item.contact?.name || '?').split(' ').map((value: string) => value[0]).slice(0,2).join(''), color: ['pink','blue','amber','teal','purple'][index % 5], message: item.lastMessage || 'No messages yet', time: item.lastMessageAt ? new Date(item.lastMessageAt).toLocaleDateString() : 'New', unread: item.unreadCount || 0, tag: item.contact?.tags?.[0] || '', stage: item.stage || 'New Lead', type: 'message' })));}).catch(error => onNotice(error.message)).finally(() => setLoading(false));
  useEffect(() => { load(); window.addEventListener('waba:data-changed', load); return () => window.removeEventListener('waba:data-changed', load); }, [inboxFilter,query,memberFilter,teamFilter,numberFilter,tagFilter,dateFilter,stage,offset]);
  useEffect(()=>{setOffset(0);},[inboxFilter,query,memberFilter,teamFilter,numberFilter,tagFilter,dateFilter,stage]);
  const visible = storedChats.filter(chat =>
    (stage === 'All' || chat.stage === stage) &&
    matchesInbox(chat, inboxFilter, user.id) &&
    (memberFilter === 'all' || chat.assignedTo === memberFilter) &&
    (channelFilter === 'All channels' || chat.channel.toLowerCase() === channelFilter.toLowerCase()) &&
    (dateFilter === 'All time' || new Date(chat.updated).getTime() >= (dateFilter === 'Today' ? new Date().setHours(0,0,0,0) : Date.now() - (dateFilter === 'Last 7 days' ? 7 : 30) * 86400000))
    );
  const ordered = sortNewest ? visible : [...visible].reverse();
  const customer = storedChats.find(chat => chat.id === selected) || null;
  useEffect(() => {
    if (!customer?.id) { setMessages([]); return; }
    let active = true;
    const refresh = () => api.messages<StoredMessage>(customer.id!).then(result => { if (active) setMessages(result.items); }).catch(error => { if (active) onNotice(error.message); });
    refresh(); const timer = window.setInterval(refresh, 5000); window.addEventListener('waba:data-changed', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('waba:data-changed', refresh); };
  }, [customer?.id]);


  const newConversation = async () => {
    if (!access.can('conversations.create') || !access.can('contacts.read')) return;
    const phone = window.prompt('Enter an existing customer’s phone number');
    if (!phone?.trim()) return;
    try {
      const contacts = await api.list<{ _id: string; phone: string }>('contacts');
      const contact = contacts.items.find(item => item.phone.replace(/\D/g, '') === phone.replace(/\D/g, ''));
      if (!contact) return onNotice('Customer not found. Add the customer in Customers first.');
      const result = await api.create<{ _id: string }>('conversations', { contact: contact._id });
      await load(); setSelected(result.item._id); setInboxFilter('all:All'); window.dispatchEvent(new Event('waba:data-changed')); onNotice('Conversation ready.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to create conversation.'); }
  };
  const updateConversation = async (updates: Record<string, unknown>) => {
    if (!access.can('conversations.update') || !customer?.id) return;
    try { await api.update('conversations', customer.id, updates); await load(); window.dispatchEvent(new Event('waba:data-changed')); onNotice('Conversation updated.'); }
    catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to update conversation.'); }
  };
  return <div className="chat-page">
    <div className="lead-stage-bar"><button onClick={() => onNotice('Previous stages shown.')}><ChevronLeft size={19}/></button><div>{stages.map(item => <button key={item} className={stage === item ? 'active' : ''} onClick={() => { setStage(item); setSelected(null); }}>{item}{<i>{storedChats.filter(chat => item === 'All' || chat.stage === item).length}</i>}</button>)}</div><button onClick={() => onNotice('More stages shown.')}><ChevronRight size={19}/></button><button onClick={() => onNotice('Pipeline filters opened.')}><SlidersHorizontal size={19}/></button></div>
    <div className={`wa-inbox-shell ${filtersCollapsed ? 'filters-collapsed' : ''}`}>
      <InboxFilters chats={storedChats} canClaim={access.role!=='agent'||access.can('conversations.claim')} filterOptions={filterOptions} teamFilter={teamFilter} setTeamFilter={setTeamFilter} numberFilter={numberFilter} setNumberFilter={setNumberFilter} userId={user.id} memberFilter={memberFilter} setMemberFilter={setMemberFilter} collapsed={filtersCollapsed} onToggleCollapse={() => setFiltersCollapsed(value => !value)} inboxFilter={inboxFilter} setInboxFilter={setInboxFilter} view={view} setView={setView} tagFilter={tagFilter} setTagFilter={setTagFilter} channelFilter={channelFilter} setChannelFilter={setChannelFilter} dateFilter={dateFilter} setDateFilter={setDateFilter} onNotice={onNotice}/>
      <section className="wa-chat-list"><header><h2>{view === 'groups' ? 'Groups' : 'All chats'}</h2><div className="chat-list-actions"><button onClick={() => document.getElementById('chat-search')?.focus()}><Search size={20}/></button><button onClick={() => setSortNewest(v => !v)} className={!sortNewest ? 'active' : ''}><ArrowDownUp size={20}/></button><button onClick={() => onNotice('Chat list options opened.')}><MoreVertical size={20}/></button></div></header><div className="chat-list-search"><Search size={16}/><input id="chat-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search chats..."/></div><div className="wa-chat-items">{view === 'groups' ? <div className="chat-list-empty"><Users size={28}/><p>No groups in this workspace.</p></div> : loading ? <div className="chat-list-empty"><p>Loading conversations…</p></div> : ordered.length === 0 ? <div className="chat-list-empty"><MessageCircleMore size={28}/><p>No conversations found.</p></div> : ordered.map(chat => { const id = chat.id || chat.name; return <button className={selected === id ? 'selected' : ''} onClick={() => setSelected(id)} key={id}><span className={`avatar-chip ${chat.color}`}>{chat.initials}<i/></span><span className="chat-item-copy"><b>{chat.name}</b><small>{chat.type === 'image' && <ImageIcon size={13}/>} {chat.type === 'contact' && <UserCircle size={13}/>} {chat.message}</small>{chat.tag && <em>{chat.tag}</em>}</span><span className="chat-item-meta">{chat.unread > 0 && <i>{chat.unread}</i>}<time>{chat.time}</time></span></button>; })}</div><div className="business-pagination"><small>{total} matching chats</small><button aria-label="Previous conversations" disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-50))}><ChevronLeft size={16}/></button><button aria-label="Next conversations" disabled={offset+50>=total} onClick={()=>setOffset(offset+50)}><ChevronRight size={16}/></button></div><Permission capability="conversations.create"><button className="new-chat-fab" onClick={newConversation}><Plus size={18}/> New</button></Permission></section>
      <section className={`wa-conversation ${customer ? 'has-chat' : ''}`}>{!customer ? <div className="select-chat-empty"><MessageCircleMore size={42}/><h3>Start a conversation</h3><p>Click any chat in the left panel to view messages.</p></div> : <><div className="chat-head"><button className="chat-back" aria-label="Back to conversations" onClick={() => setSelected(null)}><ChevronLeft size={18}/></button><span className={`avatar-chip ${customer.color}`}>{customer.initials}</span><div><b>{customer.name}</b><small><i/> WhatsApp · {customer.stage}</small></div><button onClick={() => onNotice('Conversation options opened.')}><MoreVertical size={17}/></button></div><div className="messages"><span className="day-label">Conversation history</span>{messages.length === 0 ? <div className="message-empty">No messages yet. Send the first message below.</div> : messages.map(message => <div className={`bubble ${message.direction === 'outbound' ? 'outbound' : 'inbound'}`} key={message._id}>{message.body}<small>{new Date(message.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}{message.direction === 'outbound' && <span title={message.error?.message}>{message.status}</span>}</small></div>)}</div><div className="reply-box"><span>Smartping template messages</span><Permission capability="conversations.send"><button disabled={access.role === 'agent' && customer.assignedTo !== user.id && !access.superadmin} onClick={() => setComposerOpen(true)}><Send size={17}/> Send template</button></Permission></div><ConversationTools chat={customer} user={user} onNotice={onNotice} onChanged={load}/></>}</section>
    </div>
    {composerOpen && customer?.id && <SmartpingComposer conversationId={customer.id} onClose={() => setComposerOpen(false)} onNotice={onNotice}/>}
  </div>;
}

type FilterProps = {
  canClaim:boolean; filterOptions:{users:any[];teams:any[];numbers:any[]};teamFilter:string;setTeamFilter:(value:string)=>void;numberFilter:string;setNumberFilter:(value:string)=>void;
  chats: Chat[];
  userId: string;
  memberFilter: string;
  setMemberFilter: (value: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  inboxFilter: string;
  setInboxFilter: (value: string) => void;
  view: 'chats' | 'groups';
  setView: (value: 'chats' | 'groups') => void;
  tagFilter: string;
  setTagFilter: (value: string) => void;
  channelFilter: string;
  setChannelFilter: (value: string) => void;
  dateFilter: string;
  setDateFilter: (value: string) => void;
  onNotice: (message: string) => void;
};

function InboxFilters(props: FilterProps) {
  const [expanded, setExpanded] = useState<string | null>(() => props.inboxFilter.split(':')[0]);
  const [helpOpen, setHelpOpen] = useState(false);
  const groups = [
    { id: 'all', label: 'All chats', icon: MessageCircleMore },
    { id: 'mine', label: 'Assigned to me', icon: UserCircle },
    { id: 'team', label: 'Team', icon: Users },
    { id: 'unassigned', label: 'Unassigned', icon: UserRoundX },
  ].filter(group=>group.id!=='unassigned'||props.canClaim).map(group => ({ ...group, items: ['All', 'Open', 'Pending', 'Unread', 'Resolved'].map(label => [label, '']) }));
  const selectFilter = (group: string, status: string) => props.setInboxFilter(`${group}:${status}`);
  return <aside className={`inbox-filter-pane ${props.collapsed ? 'collapsed' : ''}`}><header><h2>Inbox</h2><span><button aria-label="Inbox help" className={helpOpen ? 'active' : ''} onClick={() => setHelpOpen(value => !value)}><CircleHelp size={19}/></button><button aria-label={props.collapsed ? 'Expand inbox filters' : 'Collapse inbox filters'} onClick={props.onToggleCollapse}>{props.collapsed ? <ChevronRight size={19}/> : <ChevronLeft size={19}/>}</button></span>{helpOpen && <div className="inbox-help-popover"><b>Inbox help</b><p>Use the sections below to filter conversations by owner, status, tag, channel or date.</p><button onClick={() => setHelpOpen(false)}>Got it</button></div>}</header>
    <div className="inbox-filter-list">{groups.map(group => <div className="filter-group" key={group.id}><button className={`filter-parent ${expanded === group.id ? 'active' : ''}`} onClick={() => setExpanded(current => current === group.id ? null : group.id)}><group.icon size={20}/><span>{group.label}</span><ChevronDown className={expanded === group.id ? 'expanded' : ''} size={17}/></button>{expanded === group.id && <div className="filter-children">{group.items.map(([label,count]) => { const value = `${group.id}:${label}`; return <button key={label} onClick={() => selectFilter(group.id,label)} className={props.inboxFilter === value ? 'active' : ''}><span>{label}</span>{count && <i>{count}</i>}{label === 'Awaiting reply' && <Clock3 size={14}/>}</button>; })}</div>}</div>)}</div>
    <div className="inbox-view-filter"><label>View</label><div><button className={props.view === 'chats' ? 'active' : ''} onClick={() => props.setView('chats')}><MessageCircleMore size={17}/> All Chats</button><button className={props.view === 'groups' ? 'active' : ''} onClick={() => props.setView('groups')}><Users size={17}/> Groups</button></div>
      <label>Agent<select value={props.memberFilter} onChange={e=>props.setMemberFilter(e.target.value)}><option value="all">All permitted agents</option>{props.filterOptions.users.map(item=><option key={item._id} value={item._id}>{item.name}</option>)}</select></label>
      <label>Team<select value={props.teamFilter} onChange={e=>props.setTeamFilter(e.target.value)}><option value="">All permitted teams</option>{props.filterOptions.teams.map(item=><option key={item._id} value={item._id}>{item.name}</option>)}</select></label>
      <label>WhatsApp number<select value={props.numberFilter} onChange={e=>props.setNumberFilter(e.target.value)}><option value="">All permitted numbers</option>{props.filterOptions.numbers.map(item=><option key={item._id} value={item._id}>{item.phone}</option>)}</select></label>
      <label>Tags</label><select value={props.tagFilter} onChange={e => props.setTagFilter(e.target.value)}><option>All tags</option>{[...new Set(props.chats.map(chat => chat.tag).filter(Boolean))].map(tag => <option key={tag}>{tag}</option>)}</select>
      <label>Channels</label><select value={props.channelFilter} onChange={e => { props.setChannelFilter(e.target.value); props.onNotice(`Channel filter: ${e.target.value}.`); }}><option>All channels</option><option>WhatsApp</option><option>Instagram</option><option>Facebook</option></select>
      <label>Date range</label><select value={props.dateFilter} onChange={e => { props.setDateFilter(e.target.value); props.onNotice(`Date range: ${e.target.value}.`); }}><option>All time</option><option>Today</option><option>Last 7 days</option><option>Last 30 days</option></select>
    </div>
  </aside>;
}
function matchesInbox(chat: Chat, filter: string, userId: string) {
  const [scope, status] = filter.split(':');
  return (scope !== 'mine' || chat.assignedTo === userId) && (scope !== 'unassigned' || !chat.assignedTo) &&
    (status === 'All' || (status === 'Unread' ? chat.unread > 0 : chat.status === ({Pending:'awaiting_reply',Resolved:'closed'}[status]||status.toLowerCase().replace(' ', '_'))));
}

