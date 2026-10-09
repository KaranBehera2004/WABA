import { useWorkspaceAccess } from '../lib/WorkspaceAccessContext';
import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clock3, Phone,
  PhoneCall, PhoneOff, Radio, Search, Tag, UserCircle
} from 'lucide-react';
import { api, type User } from '../lib/api';

type CallRecord = {
  id: number | string;
  name: string;
  owner: string;
  date: string;
  time: string;
  type: 'Missed' | 'Declined' | 'Outgoing' | 'Incoming' | 'Not Connected';
  tag: string;
  callback: boolean;
  mine: boolean;
  occurredAt: string;
};

export default function CallLogs({ user, onNotice }: { user: User; onNotice: (message: string) => void }) {
  const access = useWorkspaceAccess();
  const [scope, setScope] = useState<'all' | 'mine'>(access.role === 'agent' ? 'mine' : 'all');
  const [expanded, setExpanded] = useState<'all' | 'mine' | null>(access.role === 'agent' ? 'mine' : 'all');
  const [status, setStatus] = useState('All');
  const [dateRange, setDateRange] = useState('All');
  const [member, setMember] = useState('All');
  const [tag, setTag] = useState('All tags');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [records, setRecords] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.list<any>('calls').then(result => setRecords(result.items.map((item: any) => ({ id: item._id, name: item.name, owner: item.ownerName || item.assignedTo?.name || 'Unassigned', date: new Date(item.occurredAt).toLocaleDateString('en-GB'), time: new Date(item.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), type: item.type, tag: item.tag || '', callback: Boolean(item.callbackPending), mine: item.assignedTo?._id === user.id, occurredAt: item.occurredAt })))).catch(error => onNotice(error.message)).finally(() => setLoading(false)); }, []);

  const filtered = useMemo(() => records.filter(call =>
    (scope === 'all' || call.mine) &&
    (dateRange === 'All' || new Date(call.occurredAt).getTime() >= (dateRange === 'Today' ? new Date().setHours(0,0,0,0) : Date.now() - (dateRange === 'Last 7 days' ? 7 : 30) * 86400000)) &&
    (status === 'All' || call.type === status) &&
    (member === 'All' || call.owner === member) &&
    (tag === 'All tags' || call.tag === tag) &&
    call.name.toLowerCase().includes(query.toLowerCase())
  ), [records, scope, status, member, tag, query, dateRange]);
  const grouped = filtered.reduce<Record<string, CallRecord[]>>((result, call) => {
    (result[call.date] ||= []).push(call);
    return result;
  }, {});

  const chooseScope = (nextScope: 'all' | 'mine', nextStatus: string) => {
    setScope(nextScope); setStatus(nextStatus);
  };

  return <div className={`call-logs-page ${filtersCollapsed ? 'filters-collapsed' : ''}`}>
    <aside className={`call-filter-pane ${filtersCollapsed ? 'collapsed' : ''}`}>
      <header><h2>Call logs</h2><button aria-label={filtersCollapsed ? 'Expand call filters' : 'Collapse call filters'} onClick={() => setFiltersCollapsed(value => !value)}>{filtersCollapsed ? <ChevronRight size={19}/> : <ChevronLeft size={19}/>}</button></header>
      {!filtersCollapsed && <><div className="call-filter-groups"><CallFilterGroup title="All calls" icon={<Phone size={20}/>} id="all" expanded={expanded === 'all'} activeScope={scope} currentStatus={status} records={records} onToggle={() => setExpanded(value => value === 'all' ? null : 'all')} onSelect={value => chooseScope('all', value)}/><CallFilterGroup title="My calls" icon={<UserCircle size={20}/>} id="mine" expanded={expanded === 'mine'} activeScope={scope} currentStatus={status} records={records.filter(call => call.mine)} onToggle={() => setExpanded(value => value === 'mine' ? null : 'mine')} onSelect={value => chooseScope('mine', value)}/></div>
      <div className="call-dropdown-filters"><label><span><CalendarDays size={15}/> Date range</span><select value={dateRange} onChange={e => { setDateRange(e.target.value); onNotice(`Call date range: ${e.target.value}.`); }}><option>All</option><option>Today</option><option>Last 7 days</option><option>Last 30 days</option></select></label><label><span><UserCircle size={15}/> Team member</span><select value={member} onChange={e => setMember(e.target.value)}><option>All</option>{[...new Set(records.map(call => call.owner))].map(owner => <option key={owner}>{owner}</option>)}</select></label><label><span><Tag size={15}/> Tags</span><select value={tag} onChange={e => setTag(e.target.value)}><option>All tags</option>{[...new Set(records.map(call => call.tag).filter(Boolean))].map(tag => <option key={tag}>{tag}</option>)}</select></label></div></>}
    </aside>
    <main className="call-results"><header><div><b>{scope === 'all' ? 'All calls' : 'My calls'}</b><ChevronRight size={17}/><span>{status}</span></div><div className={`call-search ${searchOpen ? 'open' : ''}`}>{searchOpen && <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search call logs..."/>}<button onClick={() => { setSearchOpen(value => !value); if (searchOpen) setQuery(''); }}><Search size={21}/></button></div></header>
      <div className="call-results-body">{loading ? <div className="no-call-state"><p>Loading call logs…</p></div> : filtered.length === 0 ? <div className="no-call-state"><div className="call-empty-art"><div className="art-head"><i/><i/><i/></div><div className="art-body"><span/><span/><span/><span/></div></div><h2>No Call Logs Found</h2><p>There are no call logs available yet. All call activities will appear<br/> here as they happen.</p></div> : Object.entries(grouped).map(([date, records]) => <section className="call-date-group" key={date}><h3>{date}</h3>{records.map(call => <button className="call-record" key={call.id} onClick={() => onNotice(`${call.name}'s call details opened.`)}><span className={`call-type-icon ${call.type.toLowerCase().replace(' ','-')}`}>{call.type === 'Outgoing' || call.type === 'Incoming' ? <PhoneCall size={21}/> : <PhoneOff size={21}/>}</span><span className="call-person"><span><b>{call.name}</b>{call.callback && <em>Callback pending</em>}</span><small><Radio size={12}/>{call.owner}</small>{call.tag && <i>{call.tag}</i>}</span><span className="call-meta"><small>WA Voice • {call.date}</small><time>{call.time}</time></span></button>)}</section>)}</div>
    </main>
  </div>;
}

function CallFilterGroup({ title, icon, id, expanded, activeScope, currentStatus, records, onToggle, onSelect }: { title: string; icon: React.ReactNode; id: 'all' | 'mine'; expanded: boolean; activeScope: string; currentStatus: string; records: CallRecord[]; onToggle: () => void; onSelect: (value: string) => void }) {
  const options = ['All', 'Missed', 'Declined', 'Outgoing', 'Incoming', 'Not Connected'].map(label => [label, String(records.filter(call => label === 'All' || call.type === label).length)]);
  return <div className="call-filter-group"><button className={`call-filter-parent ${expanded ? 'expanded' : ''}`} onClick={onToggle}>{icon}<span>{title}</span><ChevronDown size={17}/></button>{expanded && <div className="call-filter-children">{options.map(([label,count]) => <button key={label} className={activeScope === id && currentStatus === label ? 'active' : ''} onClick={() => onSelect(label)}><span>{label}</span>{<i>{count}</i>}</button>)}</div>}</div>;
}
