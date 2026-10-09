import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Building2, Check, RefreshCw, ShieldCheck, UserPlus, X } from 'lucide-react';
import { superadminApi as admin } from '../lib/api';
import { accountWorkspaceWarning, createAccountPayload, initialAccountCreateValues, newBusinessOwnerSeed, readAccountPolicy, validateAccountCreate, type AccountCreateContext, type AccountCreateValues, type AccountPolicy, type AccountWorkspaceOption, type NewBusinessOwnerSeed } from '../lib/accountCreate';

type Props = { workspaces: AccountWorkspaceOption[]; initialWorkspaceId?: string; onClose: () => void; onSaved: () => Promise<void>; onNewBusiness: (ownerSeed: NewBusinessOwnerSeed) => void };

export default function CreateAccountModal({ workspaces, initialWorkspaceId = '', onClose, onSaved, onNewBusiness }: Props) {
  const [values, setValues] = useState(() => ({ ...initialAccountCreateValues(), workspaceId: initialWorkspaceId }));
  const [policy, setPolicy] = useState<AccountPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const loadVersion = useRef(0);
  const saving = useRef(false);
  const confirmed = useRef(false);
  const context: AccountCreateContext | null = policy ? { workspaces, policy } : null;
  const chosenWorkspace = workspaces.find(workspace => workspace._id === values.workspaceId);
  const workspaceWarning = values.mode === 'existing' ? accountWorkspaceWarning(chosenWorkspace) : '';
  const disabled = busy || created;
  const update = <K extends keyof AccountCreateValues>(key: K, value: AccountCreateValues[K]) => { setValues(current => ({ ...current, [key]: value })); setError(''); };
  const loadPolicy = async () => {
    const version = ++loadVersion.current;
    setLoading(true); setLoadError(''); setPolicy(null);
    try {
      const result = await admin.get<{ settings: unknown }>('/settings');
      const next = readAccountPolicy(result.settings);
      if (mounted.current && version === loadVersion.current) setPolicy(next);
    } catch (caught) {
      if (mounted.current && version === loadVersion.current) setLoadError(caught instanceof Error ? caught.message : 'Unable to load account security policy.');
    } finally { if (mounted.current && version === loadVersion.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    formRef.current?.focus(); loadPolicy();
    return () => { mounted.current = false; loadVersion.current++; previous?.focus(); };
  }, []);
  const focusField = (field: string) => window.setTimeout(() => { if (mounted.current) formRef.current?.querySelector<HTMLElement>(`#account-create-${field}`)?.focus(); }, 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving.current || loading || !context) return;
    if (!confirmed.current) {
      const problem = validateAccountCreate(values, context);
      if (problem) { setError(problem.message); focusField(problem.field); return; }
    }
    saving.current = true; setBusy(true); setError('');
    try {
      if (values.mode === 'new' && !confirmed.current) { onNewBusiness(newBusinessOwnerSeed(values, context)); return; }
      if (!confirmed.current) {
        await admin.post('/users', createAccountPayload(values, context));
        confirmed.current = true;
        if (mounted.current) { setCreated(true); setValues(current => ({ ...current, password: '', confirmPassword: '' })); }
      }
      await onSaved();
    } catch (caught) {
      if (mounted.current) setError(confirmed.current ? `The account was created. Refreshing the list failed: ${caught instanceof Error ? caught.message : 'please retry refreshing the list.'}` : caught instanceof Error ? caught.message : 'Unable to create the account.');
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const trapFocus = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...(formRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') || [])];
    if (!nodes.length) { event.preventDefault(); formRef.current?.focus(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === formRef.current)) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === formRef.current)) { event.preventDefault(); first.focus(); }
  };
  const passwordHint = policy ? `At least ${policy.passwordMinLength} characters${policy.passwordRequireUppercase || values.mode === 'new' ? ', an uppercase letter' : ''}${values.mode === 'new' ? ', a lowercase letter' : ''}${policy.passwordRequireNumber || values.mode === 'new' ? ', a number' : ''}; maximum 72 UTF-8 bytes.` : '';

  return <div className="modal-backdrop"><form ref={formRef} className="admin-dialog workspace-create-dialog account-create-dialog" role="dialog" aria-modal="true" aria-labelledby="account-create-heading" aria-describedby="account-create-intro" tabIndex={-1} onKeyDown={trapFocus} onSubmit={submit} noValidate>
    <div className="admin-dialog-header"><div><h2 id="account-create-heading"><UserPlus size={23} aria-hidden="true"/> Create account</h2><p id="account-create-intro" className="workspace-create-intro">Connect the account to a real business, create a new business with its owner, or explicitly grant platform administration.</p></div><button type="button" disabled={busy} aria-label="Close create account" onClick={onClose}><X size={20}/></button></div>
    <div className="workspace-create-body">
      {loading ? <div className="workspace-create-loading" role="status"><RefreshCw size={22} aria-hidden="true"/> Loading account security policy...</div> : loadError ? <div className="workspace-create-loading"><p className="admin-error" role="alert">{loadError}</p><button type="button" className="outline-reference" onClick={loadPolicy}><RefreshCw size={17}/> Retry loading policy</button><p className="workspace-create-help">Account creation is disabled until the security policy is available.</p></div> : <>
        <label className="admin-field"><span>Business / access setup</span><select id="account-create-mode" value={values.mode} disabled={disabled} onChange={event => { setValues(current => ({ ...current, mode: event.target.value as AccountCreateValues['mode'], acknowledgePlatformAccess: false })); setError(''); }}><option value="existing">Join an existing business</option><option value="new">Create a new business and owner</option><option value="platform">Platform superadmin — no business</option></select></label>
        {values.mode === 'existing' && <><h3><Building2 size={20} aria-hidden="true"/> Existing business</h3><div className="workspace-create-grid"><label className="admin-field"><span>Business / workspace <span aria-hidden="true">*</span></span><select id="account-create-workspaceId" value={values.workspaceId} disabled={disabled} required onChange={event => update('workspaceId', event.target.value)}><option value="">Select a stored business</option>{workspaces.map(workspace => <option value={workspace._id} key={workspace._id}>{workspace.name} — {workspace._id.slice(-6)}{workspace.isActive === false ? ' (suspended)' : accountWorkspaceWarning(workspace) ? ' (expired)' : ''}</option>)}</select><small>{workspaces.length ? 'The account joins the selected business, not a typed company name.' : 'No businesses available. Choose Create a new business and owner instead.'}</small></label><label className="admin-field"><span>Business role</span><select id="account-create-workspaceRole" value={values.workspaceRole} disabled={disabled} onChange={event => update('workspaceRole', event.target.value as AccountCreateValues['workspaceRole'])}><option value="agent">Agent</option><option value="admin">Business admin</option><option value="supervisor">Supervisor</option></select><small>Business admins manage the business. Agents work within their assigned permissions.</small></label></div><p className="workspace-create-help">The selected business’s role seat limits and total team-member capacity apply. Creating this account does not replace or transfer its owner.</p>{workspaceWarning && <p className="workspace-create-note" role="status">{workspaceWarning}</p>}</>}
        {values.mode === 'new' && <p className="workspace-create-note"><Building2 size={20} aria-hidden="true"/> Next, complete business details, plan, add-ons and capacity limits. This account is created together with the business only after confirming the full setup wizard.</p>}
        {values.mode === 'platform' && <p className="workspace-create-note"><ShieldCheck size={20} aria-hidden="true"/> Superadmin access is platform-wide, not a business role. This person can control all businesses and platform settings.</p>}
        <h3>{values.mode === 'new' ? 'New business owner login' : 'Login details'}</h3><div className="workspace-create-grid">
          <label className="admin-field"><span>Name <span aria-hidden="true">*</span></span><input id="account-create-name" value={values.name} disabled={disabled} required maxLength={80} autoComplete="name" onChange={event => update('name', event.target.value)}/></label>
          <label className="admin-field"><span>Login email <span aria-hidden="true">*</span></span><input id="account-create-email" type="email" value={values.email} disabled={disabled} required maxLength={200} autoComplete="off" onChange={event => update('email', event.target.value)}/><small>Must not already belong to another account.</small></label>
          <label className="admin-field"><span>Initial password <span aria-hidden="true">*</span></span><input id="account-create-password" type="password" value={values.password} disabled={disabled} required minLength={policy?.passwordMinLength || 10} autoComplete="new-password" onChange={event => update('password', event.target.value)}/><small>{passwordHint}</small></label>
          <label className="admin-field"><span>Confirm password <span aria-hidden="true">*</span></span><input id="account-create-confirmPassword" type="password" value={values.confirmPassword} disabled={disabled} required autoComplete="new-password" onChange={event => update('confirmPassword', event.target.value)}/><small>Share the initial login securely. It will not be shown after account creation.</small></label>
        </div>
        {values.mode === 'platform' && <label className="workspace-create-toggle account-create-platform-confirm"><input id="account-create-acknowledgePlatformAccess" type="checkbox" checked={values.acknowledgePlatformAccess} disabled={disabled} onChange={event => update('acknowledgePlatformAccess', event.target.checked)}/><span><b>I confirm this person should have full superadmin access</b><small>This grants control of all businesses and platform settings, not only one workspace.</small></span></label>}
      </>}
      {created && <p className="workspace-create-note" role="status"><Check size={18} aria-hidden="true"/> Account created successfully. Refresh the list or close this dialog.</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
    </div>
    <div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{created ? 'Close' : 'Cancel'}</button><button type="submit" className="green-reference" disabled={loading || Boolean(loadError) || busy}>{busy ? created ? 'Refreshing...' : values.mode === 'new' ? 'Opening setup...' : 'Creating...' : created ? 'Refresh account list' : values.mode === 'new' ? 'Continue business setup' : values.mode === 'platform' ? 'Create platform superadmin' : 'Create business account'}</button></div>
  </form></div>;
}
