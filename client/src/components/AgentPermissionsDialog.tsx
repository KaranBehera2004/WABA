import { FormEvent, useEffect, useRef, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { superadminApi as admin } from '../lib/api';

type Configuration = { workspace: { _id: string; name: string }; member: { user: string; role: 'agent'; disabled: boolean }; version: number; capabilities: string[]; inheritedPermissions: string[]; customPermissions: string[] | null; effectivePermissions: string[] };
type Props = { workspaceId: string; userId: string; name: string; onClose: () => void; onSaved: (message: string) => void };
const groups: Record<string, string> = { overview: 'My dashboard', contacts: 'Contacts', conversations: 'Inbox & conversations', calls: 'Call logs', templates: 'Approved templates', content: 'Quick replies & tags' };
const actions: Record<string, string> = { read: 'View', update: 'Edit / update', send: 'Send replies', claim: 'Claim unassigned chats', create: 'Create', delete: 'Delete', manage: 'Manage', assign: 'Assign / take over', export: 'Export' };

export default function AgentPermissionsDialog({ workspaceId, userId, name, onClose, onSaved }: Props) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [permissions, setPermissions] = useState<string[]>([]); const [inherit, setInherit] = useState(true);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null); const saving = useRef(false);
  const endpoint = `/workspaces/${workspaceId}/members/${userId}/permissions`;
  const load = async () => {
    setLoading(true); setError('');
    try { const data = await admin.get<Configuration>(endpoint); setConfiguration(data); setPermissions(data.effectivePermissions); setInherit(data.customPermissions === null); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to load Agent permissions.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [workspaceId, userId]);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.focus(); return () => previous?.focus(); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!configuration || saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try { const result = await admin.put<{ message: string }>(endpoint, { permissions: inherit ? null : permissions, expectedVersion: configuration.version }); onSaved(result.message); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save Agent permissions.'); }
    finally { saving.current = false; setBusy(false); }
  };
  const trapFocus = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') || []);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <div className="modal-backdrop agent-permissions-backdrop"><form className="admin-dialog agent-permissions-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-permissions-heading" aria-busy={busy || loading} tabIndex={-1} ref={dialog} onKeyDown={trapFocus} onSubmit={submit}>
    <div className="admin-dialog-header"><h2 id="agent-permissions-heading"><ShieldCheck size={20}/> Agent permissions · {name}</h2><button type="button" disabled={busy} aria-label="Close Agent permissions" onClick={onClose}><X size={20}/></button></div>
    <p className="workspace-management-help">Choose permissions for this Agent in <b>{configuration?.workspace.name || 'this business'}</b>. Their role stays Agent. Other users and businesses retain their current access.</p>
    {error && <p className="admin-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading Agent permissions…</p> : !configuration ? <button type="button" onClick={load}>Try again</button> : <>
      {configuration.member.disabled && <div className="workspace-create-note" role="status"><b>This Agent cannot open the business because access is disabled.</b><p>To restore access, return to Members, check Business access for {name}, and click Save members. Feature permissions apply after business access is enabled.</p><button type="button" onClick={onClose}>Back to business access</button></div>}
      <label className="workspace-management-check agent-permission-inherit"><input type="checkbox" disabled={busy} checked={inherit} onChange={event => { setInherit(event.target.checked); if (event.target.checked) setPermissions(configuration.inheritedPermissions); }}/>Use business role permissions</label>
      <p className="workspace-management-help">{inherit ? 'This Agent follows the business’s shared Agent role permissions. Uncheck the option above to choose individual permissions.' : 'Only the checked actions will be available to this Agent. Unchecking all actions removes their feature access.'} Claiming also requires business routing to allow it. Additional actions must first be enabled under Roles & creation access. Plan features and assigned conversation visibility still apply.</p>
      {!inherit && <div className="admin-row-actions agent-permission-actions"><button type="button" disabled={busy} onClick={() => setPermissions([...configuration.capabilities])}>Select available actions</button><button type="button" disabled={busy} onClick={() => setPermissions([])}>Clear actions</button></div>}
      <div className="agent-permission-groups">{[...new Set(configuration.capabilities.map(value => value.split('.')[0]))].map(group => <fieldset key={group} disabled={busy || inherit}><legend>{groups[group] || group}</legend>{configuration.capabilities.filter(value => value.startsWith(group + '.')).map(value => <label className="workspace-management-check" key={value}><input aria-label={`Agent permission ${value}`} type="checkbox" checked={permissions.includes(value)} onChange={event => setPermissions(current => event.target.checked ? [...new Set([...current, value])] : current.filter(item => item !== value))}/>{actions[value.split('.')[1]] || value.split('.')[1]}</label>)}</fieldset>)}</div>
      <div className="agent-permission-review"><b>{inherit ? 'Business role defaults' : `${permissions.length} custom actions selected`}</b><span>{name} · Agent · {configuration.workspace.name}</span></div>
    </>}
    <div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button>{configuration && !loading && <><button type="button" disabled={busy} onClick={load}>Reload permissions</button><button type="submit" className="green-reference" disabled={busy}>{busy ? 'Saving…' : 'Save Agent permissions'}</button></>}</div>
  </form></div>;
}
