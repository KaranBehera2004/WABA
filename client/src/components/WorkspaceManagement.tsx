import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, KeyRound, Settings, ShieldCheck, Users, X } from 'lucide-react';
import { superadminApi as admin } from '../lib/api';
import WorkspaceCustomPlan from './WorkspaceCustomPlan';
import RoleAccessEditor from './RoleAccessEditor';

type Item = Record<string, any> & { _id: string };
type Details = { workspace: Item; users: Item[]; passwordPolicy: { minLength: number; requireUppercase: boolean; requireNumber: boolean } };
type Props = { workspaceId: string; currentUser: string; onClose: () => void; onChanged: () => Promise<void>; onConfigure: (workspace: Item) => void; onMembers: (workspace: Item) => void; onCreateAccount: () => void; onNavigate: (section: string, id: string) => void; onOpen: (id: string) => void };

export default function WorkspaceManagement(props: Props) {
  const [data, setData] = useState<Details | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [search, setSearch] = useState('');
  const [action, setAction] = useState<{ type: 'account' | 'password' | 'sessions'; user: Item } | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [editingRoles, setEditingRoles] = useState(false);
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [active, setActive] = useState(true);
  const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const load = async () => { setLoading(true); setError(''); try { setData(await admin.get<Details>(`/workspaces/${props.workspaceId}/manage`)); } catch (error) { setError(error instanceof Error ? error.message : 'Unable to load workspace management.'); } finally { setLoading(false); } };
  useEffect(() => { load(); }, [props.workspaceId]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const choose = (type: 'account' | 'password' | 'sessions', user: Item) => {
    setAction({ type, user }); setName(user.name); setEmail(user.email); setActive(user.isActive !== false);
    setPassword(''); setConfirmPassword(''); setError(''); setNotice('');
  };
  const back = () => { setAction(null); setPassword(''); setConfirmPassword(''); setError(''); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!action || !data) return;
    setError(''); setBusy(true);
    try {
      const id = action.user._id; const workspace = props.workspaceId;
      if (action.type === 'password') {
        if (password !== confirmPassword) throw new Error('Passwords do not match.');
        if (password.length < data.passwordPolicy.minLength) throw new Error(`Use at least ${data.passwordPolicy.minLength} characters.`);
        if (new TextEncoder().encode(password).length > 72) throw new Error('Password must be at most 72 UTF-8 bytes.');
        await admin.post(`/users/${id}/reset-password`, { workspace, password });
        setNotice(`Password updated for ${action.user.name}. Existing sessions were revoked.`);
      } else if (action.type === 'sessions') {
        await admin.post(`/security/users/${id}/revoke`, { workspace }); setNotice(`Existing sessions revoked for ${action.user.name}.`);
      } else {
        await admin.patch(`/users/${id}`, { workspace, name: name.trim(), email: email.trim(), isActive: active }); setNotice(`Account updated for ${name.trim()}.`);
      }
      back(); await load(); await props.onChanged();
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save changes.'); }
    finally { setBusy(false); }
  };
  const workspace = data?.workspace;
  const scopedWorkspace = workspace && { ...workspace, owner: data.users.find(user => user._id === String(workspace.owner)) || { _id: workspace.owner }, members: workspace.members.map((member: any) => ({ ...member, user: data.users.find(user => user._id === String(member.user)) || { _id: member.user, name: 'Unavailable account' } })) };
  return <div className="modal-backdrop"><div ref={dialog} tabIndex={-1} className="admin-dialog workspace-management" role="dialog" aria-modal="true" aria-label="Manage workspace" onKeyDown={event => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); props.onClose(); }
    if (event.key === 'Tab') { const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])]; const first = elements[0], last = elements[elements.length - 1]; if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
  }}>
    <div className="admin-dialog-header"><div><p className="workspace-management-eyebrow">Workspace management</p><h2>{workspace?.name || 'Manage business'}</h2></div><button disabled={busy} onClick={props.onClose} aria-label="Close workspace management"><X size={20}/></button></div>
    {error && <p className="admin-error" role="alert">{error}</p>}{notice && <p className="admin-notice" role="status">{notice}</p>}
    {loading ? <p role="status">Loading workspace details…</p> : !data || !workspace ? <button onClick={load}>Try again</button> : editingRoles ? <RoleAccessEditor workspaceId={props.workspaceId} onBack={() => setEditingRoles(false)} onSaved={async message => { setNotice(message); await props.onChanged(); }}/>: editingPlan ? <WorkspaceCustomPlan workspaceId={props.workspaceId} onBack={() => setEditingPlan(false)} onBusy={setBusy} onSaved={async message => { setEditingPlan(false); setNotice(message); await load(); try { await props.onChanged(); } catch (error) { setError(error instanceof Error ? `Plan saved, but refreshing the workspace list failed: ${error.message}` : 'Plan saved, but refreshing the workspace list failed.'); } }}/> : action ? <form onSubmit={submit}>
      <button type="button" className="workspace-management-back" disabled={busy} onClick={back}><ArrowLeft size={15}/> Back to members</button>
      <h3>{action.type === 'password' ? 'Reset password' : action.type === 'sessions' ? 'Revoke sessions' : 'Edit account'} · {action.user.name}</h3><p className="workspace-management-help">{action.user.email}</p>
      {action.type === 'password' ? <><p className="workspace-management-help">Set a new account password. Existing passwords cannot be viewed. This signs the account out of every workspace.</p><p className="workspace-management-help">At least {data.passwordPolicy.minLength} characters{data.passwordPolicy.requireUppercase ? ', including an uppercase letter' : ''}{data.passwordPolicy.requireNumber ? ', including a number' : ''}.</p><label className="admin-field">New password<input autoFocus type="password" autoComplete="new-password" required minLength={data.passwordPolicy.minLength} value={password} disabled={busy} onChange={event => setPassword(event.target.value)}/></label><label className="admin-field">Confirm new password<input type="password" autoComplete="new-password" required value={confirmPassword} disabled={busy} onChange={event => setConfirmPassword(event.target.value)}/></label></> : action.type === 'sessions' ? <p className="workspace-create-note">Sign this account out of all current sessions across all businesses? The password stays the same. The account can sign in again if its access is active.</p> : <><label className="admin-field">Name<input autoFocus required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label><label className="admin-field">Email<input required type="email" value={email} disabled={busy} onChange={event => setEmail(event.target.value)}/></label><label className="workspace-management-check"><input type="checkbox" disabled={busy || action.user._id === props.currentUser} checked={active} onChange={event => setActive(event.target.checked)}/> Account active</label><p className="workspace-create-note">Account status applies to every business this user belongs to. Disabling revokes current sessions. The last active Business Admin is protected. Use Members & roles to change access only in this business.</p></>}
      <div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={back}>Cancel</button><button type="submit" disabled={busy} className="green-reference">{busy ? 'Saving…' : action.type === 'password' ? 'Confirm password reset' : action.type === 'sessions' ? 'Confirm session revocation' : 'Save account'}</button></div>
    </form> : <>
      <div className="workspace-management-summary"><span className={`admin-badge ${workspace.isActive !== false ? 'good' : 'bad'}`}>{workspace.isActive !== false ? 'Active' : 'Suspended'}</span><span>{workspace.customPlan?.name || workspace.plan?.name || 'Unrestricted plan'}</span>{workspace.customPlan && <span className="admin-badge">Custom · {workspace.customPlan.currency} {workspace.customPlan.monthlyPrice.toLocaleString()} / month</span>}<span>{data.users.length} accounts</span></div>
      <div className="workspace-management-tools"><button onClick={() => props.onConfigure(scopedWorkspace!)}><Settings size={17}/> Business & access</button><button onClick={() => { setError(''); setNotice(''); setEditingPlan(true); }}><Settings size={17}/>{workspace.customPlan ? 'Edit custom plan' : 'Set custom plan'}</button><button onClick={() => { setError(''); setNotice(''); setEditingRoles(true); }}><ShieldCheck size={17}/> Roles & creation access</button><button onClick={() => props.onMembers(scopedWorkspace!)}><Users size={17}/> Members & roles</button><button onClick={() => props.onNavigate('Permissions', workspace._id)}><ShieldCheck size={17}/> Permissions</button><button onClick={() => props.onOpen(workspace._id)}>Open business workspace</button></div>
      <div className="workspace-management-section"><h3>Accounts & security</h3><button className="outline-reference" onClick={props.onCreateAccount}>Create account</button></div><p className="workspace-management-help">Manage the accounts linked to this business. Account changes, passwords and session revocation apply across their businesses.</p><label className="admin-field">Find a member<input type="search" value={search} placeholder="Search name or email" onChange={event => setSearch(event.target.value)}/></label>
      <div className="workspace-management-members">{data.users.filter(user => `${user.name} ${user.email}`.toLowerCase().includes(search.toLowerCase())).map(user => {
        const member = workspace.members.find((member: any) => String(member.user) === user._id);
        return <article className="workspace-management-member" key={user._id}><div><b>{user.name}</b><small>{user.email}</small><div className="workspace-management-member-meta"><span className="admin-badge">{member?.role === 'supervisor' ? 'Supervisor' : member?.role === 'agent' ? 'Agent' : ['owner','admin'].includes(member?.role) ? 'Business Admin' : 'Reassignment required'}</span><span>{!user.isActive ? 'Account disabled' : member?.disabled || member?.role === 'viewer' ? 'Business access disabled' : 'Active'}</span></div><small>Last login: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</small></div><div className="admin-row-actions"><button onClick={() => choose('account', user)}>Edit account</button><button onClick={() => choose('password', user)}><KeyRound size={14}/> Reset password</button><button disabled={user._id === props.currentUser} title={user._id === props.currentUser ? 'Use sign out for your own session' : undefined} onClick={() => choose('sessions', user)}>Revoke sessions</button></div></article>;
      })}{!data.users.some(user => `${user.name} ${user.email}`.toLowerCase().includes(search.toLowerCase())) && <p className="admin-empty">No matching members.</p>}</div>
      <div className="admin-dialog-actions"><button onClick={props.onClose}>Close</button></div>
    </>}
  </div></div>;
}
