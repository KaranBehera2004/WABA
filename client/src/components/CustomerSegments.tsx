import { Permission, useWorkspaceAccess } from '../lib/WorkspaceAccessContext';
import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bolt, Check, ChevronDown, Download, Eye, FileDown, FileSpreadsheet, Filter,
  MoreVertical, Plus, Search, Upload, X
} from 'lucide-react';
import { api } from '../lib/api';

type Contact = { _id: string; name: string; phone: string; email?: string; tags?: string[]; subscribed: boolean; source?: string; createdAt: string };
type Segment = { id: string; name: string; dynamic?: boolean; criteria?: { contactIds?: string[] } };

const initialSegments: Segment[] = [{ id: 'all', name: 'All customers', dynamic: true }];

export default function CustomerSegments({ onNotice }: { onNotice: (message: string) => void }) {
  const access = useWorkspaceAccess();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [segments, setSegments] = useState(initialSegments);
  const [activeSegment, setActiveSegment] = useState('all');
  const [segmentQuery, setSegmentQuery] = useState('');
  const [segmentSearchOpen, setSegmentSearchOpen] = useState(false);
  const [customerQuery, setCustomerQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [onlySubscribed, setOnlySubscribed] = useState(false);
  const [creatingSegment, setCreatingSegment] = useState(false);
  const [segmentName, setSegmentName] = useState('');
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => api.list<Contact>('contacts').then(result => setContacts(result.items)).catch(error => onNotice(error.message)).finally(() => setLoading(false));
  useEffect(() => {
    const refresh = () => {
      load();
      if (access.can('segments.read')) api.list<Segment & { _id: string }>('segments').then(result => setSegments([...initialSegments, ...result.items.map(item => ({ ...item, id: item._id }))])).catch(error => onNotice(error.message));
    };
    refresh(); window.addEventListener('waba:data-changed', refresh);
    return () => window.removeEventListener('waba:data-changed', refresh);
  }, []);
  const filtered = useMemo(() => contacts.filter(contact => {
    const matchesSearch = `${contact.name} ${contact.phone} ${contact.email || ''}`.toLowerCase().includes(customerQuery.toLowerCase());
    const matchesSegment = activeSegment === 'all' || segments.find(segment => segment.id === activeSegment)?.criteria?.contactIds?.includes(contact._id);
    return matchesSearch && matchesSegment && (!onlySubscribed || contact.subscribed);
  }), [contacts, customerQuery, activeSegment, onlySubscribed, segments]);
  const allSelected = filtered.length > 0 && filtered.every(contact => selected.includes(contact._id));

  const toggleAll = () => setSelected(allSelected ? selected.filter(id => !filtered.some(contact => contact._id === id)) : [...new Set([...selected, ...filtered.map(contact => contact._id)])]);
  const toggleOne = (id: string) => setSelected(value => value.includes(id) ? value.filter(item => item !== id) : [...value, id]);
  const download = (filename: string, content: string) => { const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url); };
  const exportContacts = () => download('waba-customers.csv', `Name,Phone,Email,Subscribed\n${filtered.map(contact => `"${contact.name}","${contact.phone}","${contact.email || ''}",${contact.subscribed}`).join('\n')}`);
  const sampleFile = () => download('customer-import-sample.csv', 'Name,Phone,Email\nSample Customer,+919876543210,sample@example.com');
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!access.can('contacts.create')) return;
    const file = event.target.files?.[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) { onNotice('Please upload a CSV file using the sample format.'); event.target.value = ''; return; }
    try {
      const rows = (await file.text()).split(/\r?\n/).slice(1).filter(Boolean).map(row => row.split(',').map(cell => cell.replace(/^"|"$/g, '').trim()));
      let imported = 0;
      for (const [name, phone, email] of rows.slice(0, 100)) { if (!name || !phone) continue; await api.create('contacts', { name, phone, email, subscribed: true, tags: ['Imported'], source: 'Excel Import' }); imported++; }
      await load(); onNotice(`${imported} customers imported into MongoDB.`);
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Import failed.'); }
    event.target.value = '';
  };
  const createSegment = async () => {
    if (!access.can('segments.create')) return;
    const name = segmentName.trim(); if (!name) return;
    try {
      const result = await api.create<Segment & { _id: string }>('segments', { name, criteria: { contactIds: selected } });
      setSegments(value => [...value, { ...result.item, id: result.item._id }]); setActiveSegment(result.item._id);
      setSegmentName(''); setCreatingSegment(false); setSelected([]); onNotice('Segment saved with the selected customers.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to create segment.'); }
  };
  const addTag = async () => {
    if (!access.can('contacts.update')) return;
    const tag = window.prompt('Tag name')?.trim(); if (!tag) return;
    try {
      await Promise.all(selected.map(id => { const contact = contacts.find(item => item._id === id); return api.update('contacts', id, { tags: [...new Set([...(contact?.tags || []), tag])] }); }));
      await load(); setSelected([]); window.dispatchEvent(new Event('waba:data-changed')); onNotice('Tag added to the selected customers.');
    } catch (error) { onNotice(error instanceof Error ? error.message : 'Unable to update customers.'); }
  };

  return <div className="customer-segments-page">
    <aside className="segments-pane"><header><h2>Customer segments</h2><button onClick={() => setSegmentSearchOpen(value => !value)}><Search size={20}/></button></header><div className={`segment-search ${segmentSearchOpen ? 'open' : ''}`}><Search size={15}/><input autoFocus={segmentSearchOpen} id="segment-search" value={segmentQuery} onChange={event => setSegmentQuery(event.target.value)} placeholder="Search segments"/></div><div className="segment-import-card"><Permission capability="contacts.create"><button onClick={() => fileRef.current?.click()}><FileSpreadsheet size={24}/><span>Excel Import</span></button></Permission><i/><button onClick={sampleFile}><FileDown size={24}/><span>Sample File</span></button><input ref={fileRef} type="file" accept=".csv" onChange={importFile} hidden/></div><nav className="segment-list">{segments.filter(segment => segment.name.toLowerCase().includes(segmentQuery.toLowerCase())).map(segment => <button key={segment.id} className={activeSegment === segment.id ? 'active' : ''} onClick={() => { setActiveSegment(segment.id); setSelected([]); }}><span>{segment.name}</span>{segment.dynamic && <Bolt size={15}/>} {segment.id !== 'all' && <MoreVertical size={16}/>}</button>)}</nav></aside>
    <main className="customers-pane"><header><div><h2>{segments.find(segment => segment.id === activeSegment)?.name || 'All customers'}</h2><span>{filtered.length.toLocaleString()}</span></div>{creatingSegment ? <div className="create-segment-inline"><input autoFocus value={segmentName} onChange={event => setSegmentName(event.target.value)} onKeyDown={event => event.key === 'Enter' && createSegment()} placeholder="Segment name"/><Permission capability="segments.create"><button onClick={createSegment}><Check size={16}/></button></Permission><button onClick={() => setCreatingSegment(false)}><X size={16}/></button></div> : <Permission capability="segments.create"><button className="create-segment-button" onClick={() => setCreatingSegment(true)}><Plus size={17}/> Create segment</button></Permission>}</header>
      <div className="customers-toolbar"><div className="customer-search"><Search size={18}/><input value={customerQuery} onChange={event => setCustomerQuery(event.target.value)} placeholder="Search Customers"/></div><div className="toolbar-popover-wrap"><button className={onlySubscribed ? 'active' : ''} onClick={() => setFilterOpen(value => !value)}><Filter size={18}/> Add Filters</button>{filterOpen && <div className="customer-toolbar-popover"><label><input type="checkbox" checked={onlySubscribed} onChange={event => setOnlySubscribed(event.target.checked)}/> Subscribed only</label><button onClick={() => { setOnlySubscribed(false); setFilterOpen(false); }}>Clear filters</button></div>}</div><span className="toolbar-spacer"/><button onClick={exportContacts}><Upload size={18}/> Export</button><div className="toolbar-popover-wrap"><button onClick={() => setViewOpen(value => !value)}><Eye size={18}/> View Options</button>{viewOpen && <div className="customer-toolbar-popover view-options"><label><input type="checkbox" checked={showEmail} onChange={event => setShowEmail(event.target.checked)}/> Show email column</label></div>}</div></div>
      {selected.length > 0 && <div className="customer-selection-bar"><b>{selected.length} selected</b><button onClick={() => setSelected([])}>Clear selection</button><Permission capability="contacts.update"><button onClick={addTag}>Add tag</button></Permission></div>}
      <div className="customers-table-wrap"><table className="customers-table"><thead><tr><th><button className={`table-checkbox ${allSelected ? 'checked' : ''}`} onClick={toggleAll}>{allSelected && <Check size={14}/>}</button></th><th>Name <span>↕</span></th><th>Phone Number <span>↕</span></th>{showEmail && <th>Email</th>}<th></th></tr></thead><tbody>{loading ? <tr><td colSpan={showEmail ? 5 : 4} className="customer-empty">Loading customers…</td></tr> : filtered.length === 0 ? <tr><td colSpan={showEmail ? 5 : 4} className="customer-empty"><b>No customers found</b><span>Import a CSV file or add contacts from your workspace.</span></td></tr> : filtered.map(contact => <tr key={contact._id}><td><button className={`table-checkbox ${selected.includes(contact._id) ? 'checked' : ''}`} onClick={() => toggleOne(contact._id)}>{selected.includes(contact._id) && <Check size={14}/>}</button></td><td>{contact.name}</td><td>{contact.phone}</td>{showEmail && <td>{contact.email || '—'}</td>}<td className="customer-row-actions"><button onClick={() => setRowMenu(rowMenu === contact._id ? null : contact._id)}><MoreVertical size={18}/></button>{rowMenu === contact._id && <div><button onClick={() => onNotice(`${contact.name}'s profile opened.`)}>View customer</button><button onClick={() => { setSelected([contact._id]); setRowMenu(null); }}>Select customer</button></div>}</td></tr>)}</tbody></table></div>
    </main>
  </div>;
}
