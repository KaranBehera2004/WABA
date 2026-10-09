import RoleAccessEditor from '../components/RoleAccessEditor';
import { FormEvent, useEffect, useState } from 'react';
import { Bell, Search, Download, Plus, ShieldCheck, X } from 'lucide-react';
import { superadminApi as admin } from '../lib/api';

type Item = Record<string, any> & { _id: string };
type Props = { tab: string; data: Record<string, any>; workspace: string; workspaces: Item[]; currentUser: string; onSaved: () => Promise<void>; onError: (message: string) => void };
const title = (text: string) => text.replace(/\./g, ' · ').replace(/^./, letter => letter.toUpperCase());
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The operation could not be completed.';
export function downloadFile(name: string, content: string) {
  const link = document.createElement('a'); const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8' }));
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function exportRecords(resource: string, workspace = '') {
  let after = '', content = '', fileName = '';
  do {
    const result = await admin.get<{ content: string; fileName: string; next: string | null }>(`/exports/${resource}?workspace=${encodeURIComponent(workspace)}&after=${after}`);
    content += (content ? '\n' : '') + result.content; fileName = result.fileName;
    if (result.next === after) throw new Error('Export cursor did not advance.');
    after = result.next || '';
  } while (after);
  downloadFile(fileName, content);
}

export function WorkspaceBulkControls({ workspaces, onSaved, onError }: { workspaces: Item[]; onSaved: () => Promise<void>; onError: (message: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]); const [action, setAction] = useState('pauseSending'); const [busy, setBusy] = useState(false); const [expanded, setExpanded] = useState(false);
  useEffect(() => setSelected([]), [workspaces]);
  const apply = async () => {
    if (window.prompt(`Apply ${action} to ${selected.length} selected workspaces? Type APPLY TO SELECTED WORKSPACES to confirm.`) !== 'APPLY TO SELECTED WORKSPACES') return;
    setBusy(true); try { await admin.post('/workspaces/bulk-control', { ids: selected, action, confirmation: 'APPLY TO SELECTED WORKSPACES' }); await onSaved(); } catch (error) { onError(errorText(error)); } finally { setBusy(false); }
  };
  return <article className="admin-card admin-bulk-control"><button className="admin-link" onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide bulk controls' : 'Show bulk workspace controls'}</button>{expanded && <><p>Select workspaces from this results page. No accounts or records are deleted by these actions.</p><div className="admin-checkbox-grid">{workspaces.map(item => <label key={item._id}><input type="checkbox" disabled={busy} checked={selected.includes(item._id)} onChange={event => setSelected(event.target.checked ? [...selected, item._id] : selected.filter(id => id !== item._id))}/>{item.name}</label>)}</div><div className="admin-toolbar"><span>{selected.length} selected</span><select aria-label="Bulk workspace action" disabled={busy} value={action} onChange={event => setAction(event.target.value)}><option value="pauseSending">Pause WhatsApp sending</option><option value="resumeSending">Resume WhatsApp sending</option><option value="suspend">Suspend workspace access</option><option value="reactivate">Reactivate workspace access</option></select><button className="green-reference" disabled={busy || !selected.length} onClick={apply}>{busy ? 'Applying...' : 'Apply to selected'}</button></div></>}</article>;
}

export default function AdminOperations(props: Props) {
  if (props.tab === 'Permissions') return props.workspace && props.data.capabilities ? <RoleAccessEditor workspaceId={props.workspace} onSaved={async () => { await props.onSaved(); }}/> : <div className="admin-empty">Choose a workspace to manage its role permissions.</div>;
  if (props.tab === 'Usage & limits') return props.data.items?.length ? <CapacityEditor {...props}/> : <div className="admin-empty">Choose a workspace to view real usage and set its capacity limits.</div>;
  if (props.tab === 'Security') return <Security {...props}/>;
  if (props.tab === 'Monitoring') return <Monitoring {...props}/>;
  if (props.tab === 'Announcements') return <Announcements {...props}/>;
  return null;
}

function PermissionEditor({ data, workspace, onSaved, onError }: Props) {
  const roles: string[] = (data.roles || []).filter((role: string) => ['admin','agent','supervisor'].includes(role));
  const roleName = (role: string) => role === 'admin' ? 'Business Admin' : role === 'supervisor' ? 'Supervisor' : 'Agent';
  const permitted = (role: string): string[] => data.allowedPermissions?.[role] || (role === 'admin' ? data.capabilities : [...(data.defaults.agent || []), 'conversations.claim']);
  const [values, setValues] = useState<Record<string, string[]>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { setValues(Object.fromEntries(roles.map(role => [role, (data.rules.find((rule: any) => rule.role === role)?.permissions || data.defaults[role]).filter((permission: string) => permitted(role).includes(permission))]))); }, [data]);
  const save = async (reset = false) => {
    if (reset && !window.confirm('Restore the default permissions for this workspace?')) return;
    setBusy(true);
    try { await admin.put(`/permissions/${workspace}`, { rules: reset ? [] : roles.map(role => ({ role, permissions: (values[role] || []).filter(permission => permitted(role).includes(permission)) })) }); await onSaved(); }
    catch (error) { onError(errorText(error)); } finally { setBusy(false); }
  };
  const groups = [...new Set<string>(data.capabilities.map((capability: string) => capability.split('.')[0]))];
  const groupNames: Record<string, string> = { overview: 'Dashboard', team: 'Users & teams', workspace: 'Business settings & WhatsApp numbers', integrations: 'Integrations', content: 'Quick replies & tags', wallet: 'Billing & wallet', audit: 'Audit logs' };
  const actionNames: Record<string, string> = { read: 'View', create: 'Create', update: 'Edit', delete: 'Delete', manage: 'Manage', send: 'Send', claim: 'Claim unassigned chats', assign: 'Assign / take over', export: 'Export' };
  return <><article className="admin-card"><h2><ShieldCheck size={20}/> Role permissions · {data.workspace.name}</h2><p>Choose the actions available to every Business Admin, Agent or Supervisor in this business. The API enforces these permissions. A module must also be included in the business plan or its add-ons.</p><p>Super Admin can explicitly grant additional business features to Agents and Supervisors. Agents keep assigned conversation access; Supervisors use assigned teams and numbers. Claiming unassigned chats also requires routing to allow claiming.</p><p>The workspace owner and platform Super Admin retain full management access. Use Business access in the Users list to change a member’s role or disable access.</p><div className="admin-permission-actions"><button className="green-reference" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save permissions'}</button><button className="outline-reference" disabled={busy} onClick={() => save(true)}>Restore defaults</button></div></article><div className="admin-table-wrap admin-permission-matrix"><table><thead><tr><th>Feature / action</th>{roles.map(role => <th key={role}>{roleName(role)}<div><button aria-label={`Allow permitted ${roleName(role)} actions`} disabled={busy} onClick={() => setValues({ ...values, [role]: [...permitted(role)] })}>Allow permitted</button><button aria-label={`Clear ${roleName(role)} permissions`} disabled={busy} onClick={() => setValues({ ...values, [role]: [] })}>Clear</button></div></th>)}</tr></thead>{groups.map(group => <tbody key={group}><tr className="admin-permission-group"><th colSpan={roles.length + 1}>{groupNames[group] || title(group)}</th></tr>{data.capabilities.filter((capability: string) => capability.startsWith(group + '.')).map((capability: string) => <tr key={capability}><td>{actionNames[capability.split('.')[1]] || title(capability)}</td>{roles.map(role => {
    const allowed = permitted(role).includes(capability);
    return <td key={role}><input aria-label={`${role} ${capability}`} type="checkbox" disabled={busy || !allowed} checked={allowed && (values[role]?.includes(capability) || false)} onChange={event => setValues({ ...values, [role]: event.target.checked ? [...new Set([...(values[role] || []), capability])] : (values[role] || []).filter(value => value !== capability) })}/>{!allowed && <small className="admin-permission-unavailable">Unavailable for this role</small>}</td>;
  })}</tr>)}</tbody>)}</table></div></>;
}

function CapacityEditor({ data, workspace, onSaved, onError }: Props) {
  const item = data.items[0];
  const [values, setValues] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => setValues(Object.fromEntries(data.keys.map((key: string) => [key, item.overrides[key] === undefined ? '' : item.overrides[key] === null ? 'unlimited' : String(item.overrides[key])]))), [data]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const limits = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '').map(([key, value]) => [key, value === 'unlimited' ? null : Number(value)])); await admin.patch(`/usage/${workspace}`, { limits }); await onSaved(); }
    catch (error) { onError(errorText(error)); } finally { setBusy(false); }
  };
  return <form onSubmit={submit}><article className="admin-card"><h2>Capacity and usage · {item.workspace.name}</h2><p>Limit the number of stored records and team members. “Inherit plan” uses the plan limit; “Unlimited” overrides it. Existing records are not deleted when you lower a limit. New ordinary-user records are blocked once the limit is reached; superadmins can still manage records.</p></article><div className="admin-table-wrap"><table><thead><tr><th>Resource</th><th>Used</th><th>Effective limit</th><th>Workspace override</th></tr></thead><tbody>{data.keys.map((key: string) => <tr key={key}><td>{title(key)}</td><td>{item.usage[key]}</td><td>{item.limits[key] === null ? 'Unlimited' : item.limits[key]}</td><td><div className="admin-capacity-control"><select aria-label={`${key} limit mode`} disabled={busy} value={values[key] === '' ? 'inherit' : values[key] === 'unlimited' ? 'unlimited' : 'limited'} onChange={event => setValues({ ...values, [key]: event.target.value === 'inherit' ? '' : event.target.value === 'unlimited' ? 'unlimited' : '0' })}><option value="inherit">Inherit plan</option><option value="unlimited">Unlimited</option><option value="limited">Set limit</option></select>{values[key] !== '' && values[key] !== 'unlimited' && <input aria-label={`${key} maximum`} type="number" min="0" step="1" required disabled={busy} value={values[key] || '0'} onChange={event => setValues({ ...values, [key]: event.target.value })}/>}</div></td></tr>)}</tbody></table></div><button className="green-reference admin-bottom-save" disabled={busy}>{busy ? 'Saving...' : 'Save capacity limits'}</button></form>;
}

function Security({ data, currentUser, onSaved, onError }: Props) {
  const [busy, setBusy] = useState(false); const [includeSuperadmins, setIncludeSuperadmins] = useState(false);
  const revoke = async (item?: Item) => {
    if (item && !window.confirm(`Sign ${item.name} out of every existing session? Their password will not change.`)) return;
    if (!item && window.prompt('This will sign out other accounts. Type REVOKE OTHER SESSIONS to confirm.') !== 'REVOKE OTHER SESSIONS') return;
    setBusy(true);
    try { await admin.post(item ? `/security/users/${item._id}/revoke` : '/security/revoke-others', item ? {} : { confirmation: 'REVOKE OTHER SESSIONS', includeSuperadmins }); await onSaved(); }
    catch (error) { onError(errorText(error)); } finally { setBusy(false); }
  };
  return <><article className="admin-card"><h2>Session security</h2><p>{data.note}</p><p>Revoking sessions forces a new login on the next API request. It does not change the account password. Your current superadmin account is excluded.</p><div className="admin-security-controls"><label><input type="checkbox" checked={includeSuperadmins} onChange={event => setIncludeSuperadmins(event.target.checked)} disabled={busy}/> Include other superadmins in global revocation</label><button className="outline-reference" disabled={busy} onClick={() => revoke()}>Sign out other accounts</button></div></article><div className="admin-table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Last login</th><th>Session version</th><th>Action</th></tr></thead><tbody>{(data.items || []).map((item: Item) => <tr key={item._id}><td><b>{item.name}</b><small>{item.email}</small></td><td>{item.role}</td><td>{item.isActive ? 'Active' : 'Suspended'}</td><td>{item.lastLoginAt ? new Date(item.lastLoginAt).toLocaleString() : 'Never'}</td><td>{item.sessionVersion || 0}</td><td><button disabled={busy || item._id === currentUser} onClick={() => revoke(item)}>Revoke sessions</button></td></tr>)}</tbody></table></div></>;
}

function Monitoring({ data, workspace, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const exportData = async () => { setBusy(true); try { await exportRecords('messages', workspace); } catch (error) { onError(errorText(error)); } finally { setBusy(false); } };
  return <><div className="admin-monitor-metrics">{(data.statuses || []).map((item: any) => <article className="admin-card" key={`${item._id.direction}-${item._id.status}`}><small>{title(item._id.direction || 'Unknown direction')}</small><b>{title(item._id.status)}</b><strong>{item.count}</strong></article>)}</div><p className="admin-explanation">Actual stored message statuses and provider errors. Unknown outcomes are not automatically retried because a provider may already have accepted the message.</p>{workspace && <button className="outline-reference admin-bottom-save" disabled={busy} onClick={exportData}><Download size={16}/> {busy ? 'Exporting...' : 'Export workspace messages'}</button>}<div className="admin-table-wrap"><table><thead><tr><th>Workspace</th><th>Message</th><th>Status</th><th>Provider ID / error</th><th>Created</th></tr></thead><tbody>{(data.items || []).map((item: Item) => <tr key={item._id}><td>{item.workspace?.name || 'Unavailable'}</td><td><b>{item.body || item.type}</b><small>{item.direction} · {item._id}</small></td><td><span className={`admin-badge ${['failed', 'unknown'].includes(item.status) ? 'bad' : ''}`}>{item.status}</span></td><td>{item.providerMessageId || 'Not confirmed'}<small>{item.error?.message || ''}</small></td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}{!data.items?.length && <tr><td colSpan={5} className="admin-empty">No messages match these filters.</td></tr>}</tbody></table></div></>;
}

function Announcements({ data, workspaces, onSaved, onError }: Props) {
  const [item, setItem] = useState<Item | null>(null); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All statuses');
  const status = (entry: Item) => !entry.isActive ? 'Draft' : entry.endsAt && new Date(entry.endsAt).getTime() <= Date.now() ? 'Expired' : entry.startsAt && new Date(entry.startsAt).getTime() > Date.now() ? 'Scheduled' : 'Live';
  const notices: Item[] = data.items || [];
  const rows = notices.filter(entry => (entry.title + ' ' + entry.message).toLowerCase().includes(query.toLowerCase()) && (filter === 'All statuses' || status(entry) === filter));
  const create = () => setItem({ _id: '', title: '', message: '', level: 'Info', audience: 'All workspaces', workspaces: [], isActive: false, startsAt: '', endsAt: '' });
  const remove = async (item: Item) => {
    if (!window.confirm('Remove announcement “' + item.title + '”?')) return;
    setBusy(true); try { await admin.remove('/announcements/' + item._id); await onSaved(); } catch (error) { onError(errorText(error)); } finally { setBusy(false); }
  };
  return <div className="announcements-workspace"><div className="announcement-summary">{[['Total notices', notices.length], ['Live now', notices.filter(entry => status(entry) === 'Live').length], ['Scheduled', notices.filter(entry => status(entry) === 'Scheduled').length], ['Drafts', notices.filter(entry => status(entry) === 'Draft').length]].map(([label,count]) => <article key={String(label)}><span>{label}</span><strong>{count}</strong></article>)}</div>
    <article className="admin-card announcement-intro"><span className="announcement-intro-icon"><Bell size={24}/></span><div><h2>Workspace announcements</h2><p>Publish an update to every business or choose specific workspaces. Set a publishing window to control when it appears.</p></div><button className="green-reference" onClick={create}><Plus size={17}/> New announcement</button></article>
    <div className="announcement-list"><div className="announcement-tools"><div><Search size={17}/><input aria-label="Search announcements" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search notices…"/></div><select aria-label="Filter announcements by status" value={filter} onChange={e => setFilter(e.target.value)}>{['All statuses','Live','Scheduled','Draft','Expired'].map(value => <option key={value}>{value}</option>)}</select><span>{rows.length} notices</span></div>
    <div className="admin-table-wrap"><table><thead><tr><th>Announcement</th><th>Audience</th><th>Priority</th><th>Publishing</th><th>Actions</th></tr></thead><tbody>{rows.map(entry => <tr key={entry._id}><td><b>{entry.title}</b><small className="notice-preview">{entry.message}</small></td><td>{entry.audience}{entry.audience === 'Selected workspaces' && <small>{entry.workspaces.length} workspace{entry.workspaces.length === 1 ? '' : 's'}</small>}</td><td><span className={'status-tag ' + (entry.level === 'Critical' ? 'critical' : entry.level === 'Warning' ? 'warning' : 'neutral')}>{entry.level}</span></td><td><span className={'status-tag ' + (status(entry) === 'Live' ? 'success' : 'neutral')}>{status(entry)}</span><small>{entry.startsAt ? new Date(entry.startsAt).toLocaleString() : 'Immediately'} → {entry.endsAt ? new Date(entry.endsAt).toLocaleString() : 'No expiry'}</small></td><td><div className="admin-row-actions"><button disabled={busy} onClick={() => setItem(entry)}>Edit</button><button className="danger" disabled={busy} onClick={() => remove(entry)}>Delete</button></div></td></tr>)}{!rows.length && <tr><td colSpan={5} className="admin-empty"><Bell size={28}/><b>{notices.length ? 'No notices match your filters' : 'Keep your workspaces in the loop'}</b><p>{notices.length ? 'Try a different search or publishing status.' : 'Create your first announcement to share an update with your businesses.'}</p></td></tr>}</tbody></table></div></div>
    {item && <AnnouncementEditor item={item} workspaces={workspaces} onClose={() => setItem(null)} onSaved={async () => { setItem(null); await onSaved(); }}/>}
  </div>;
}
function AnnouncementEditor({ item, workspaces, onClose, onSaved }: { item: Item; workspaces: Item[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const localDate = (value: string) => { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const [values, setValues] = useState<Item>({ ...item, startsAt: localDate(item.startsAt), endsAt: localDate(item.endsAt) }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const payload = { ...values, startsAt: values.startsAt ? new Date(values.startsAt).toISOString() : null, endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : null }; if (item._id) await admin.patch(`/announcements/${item._id}`, payload); else await admin.post('/announcements', payload); await onSaved(); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="admin-dialog" role="dialog" aria-modal="true" aria-label="Announcement editor" onSubmit={submit}><div className="admin-dialog-header"><h2>{item._id ? 'Edit announcement' : 'New announcement'}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={20}/></button></div><label className="admin-field"><span>Title</span><input required maxLength={120} disabled={busy} value={values.title} onChange={event => setValues({ ...values, title: event.target.value })}/></label><label className="admin-field"><span>Message</span><textarea required maxLength={2000} rows={4} disabled={busy} value={values.message} onChange={event => setValues({ ...values, message: event.target.value })}/></label><label className="admin-field"><span>Level</span><select disabled={busy} value={values.level} onChange={event => setValues({ ...values, level: event.target.value })}>{['Info', 'Warning', 'Critical'].map(level => <option key={level}>{level}</option>)}</select></label><label className="admin-field"><span>Audience</span><select disabled={busy} value={values.audience} onChange={event => setValues({ ...values, audience: event.target.value })}>{['All workspaces', 'Selected workspaces'].map(value => <option key={value}>{value}</option>)}</select></label>{values.audience === 'Selected workspaces' && <div className="admin-checkbox-grid">{workspaces.map(workspace => <label key={workspace._id}><input type="checkbox" disabled={busy} checked={values.workspaces.includes(workspace._id)} onChange={event => setValues({ ...values, workspaces: event.target.checked ? [...values.workspaces, workspace._id] : values.workspaces.filter((id: string) => id !== workspace._id) })}/>{workspace.name}</label>)}</div>}{[['startsAt', 'Start time (optional)'], ['endsAt', 'End time (optional)']].map(([key, title]) => <label className="admin-field" key={key}><span>{title}</span><input type="datetime-local" disabled={busy} value={values[key]} onChange={event => setValues({ ...values, [key]: event.target.value })}/></label>)}<label className="admin-setting-switch"><b>Publish announcement</b><input type="checkbox" disabled={busy} checked={values.isActive} onChange={event => setValues({ ...values, isActive: event.target.checked })}/></label>{error && <p className="admin-error">{error}</p>}<div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="green-reference" disabled={busy}>{busy ? 'Saving...' : 'Save announcement'}</button></div></form></div>;
}
