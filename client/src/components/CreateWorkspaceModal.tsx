import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import { RoleAccessFields, type RolePolicy, businessRoleNames } from './RoleAccessEditor';
import { superadminApi as admin } from '../lib/api';
import { CAPACITY_KEYS, SEAT_LIMIT_KEYS, WORKSPACE_STEPS, createWorkspacePayload, effectiveWorkspaceFeatures, initialWorkspaceCreateValues, readWorkspaceDefaults, selectedWorkspacePlan, validateWorkspaceCreate, workspaceSlug, type WorkspaceCreateContext, type WorkspaceCreateValues, type WorkspaceDefaults, type WorkspaceOwnerOption, type WorkspacePlanOption, type WorkspaceStep } from '../lib/workspaceCreate';

export type WorkspaceOwnerSeed = { name: string; email: string; password: string; confirmPassword: string };
type Props = { users: WorkspaceOwnerOption[]; plans: WorkspacePlanOption[]; features: string[]; initialOwner?: WorkspaceOwnerSeed | null; onClose: () => void; onSaved: () => Promise<void> };
const titles: Record<string, string> = { contacts: 'Customers', conversations: 'Chats', calls: 'Calls', campaigns: 'Campaigns', templates: 'Templates', automations: 'Bot Studio', analytics: 'Analytics', dashboards: 'Enterprise Analytics', reports: 'Reports', segments: 'Audience segments', ads: 'Meta ads', team: 'Team', members: 'Team members' };
const title = (key: string) => titles[key] || key[0]?.toUpperCase() + key.slice(1);
const seatTitles = { admin: 'Business admins', agent: 'Agents', supervisor: 'Supervisors' };

export default function CreateWorkspaceModal({ users, plans, features, initialOwner, onClose, onSaved }: Props) {
  const [values, setValues] = useState(() => ({ ...initialWorkspaceCreateValues(), ...(initialOwner ? { ownerMode: 'new' as const, newOwnerName: initialOwner.name, newOwnerEmail: initialOwner.email, newOwnerPassword: initialOwner.password, confirmOwnerPassword: initialOwner.confirmPassword } : {}) }));
  const [roleCapabilities, setRoleCapabilities] = useState<string[]>([]);
  const [step, setStep] = useState<WorkspaceStep>('Business');
  const [defaults, setDefaults] = useState<WorkspaceDefaults | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const loadVersion = useRef(0);
  const saving = useRef(false);
  const confirmed = useRef(false);
  const activeUsers = users.filter(user => user.isActive === true);
  const activePlans = plans.filter(plan => plan.isActive === true);
  const owner = values.ownerMode === 'existing' ? users.find(user => user._id === values.owner) : undefined;
  const ownerEmail = values.ownerMode === 'new' ? values.newOwnerEmail.trim() : owner?.email || '';
  const context: WorkspaceCreateContext | null = defaults ? { users, plans, features, defaults } : null;
  const chosenPlan = context ? selectedWorkspacePlan(values, context) : undefined;
  const defaultPlan = defaults?.defaultPlan ? plans.find(plan => plan._id === defaults.defaultPlan) : undefined;
  const effectiveFeatures = context ? effectiveWorkspaceFeatures(values, context) : [];
  const disabled = busy || created;
  const update = <K extends keyof WorkspaceCreateValues>(key: K, value: WorkspaceCreateValues[K]) => { setValues(current => ({ ...current, [key]: value })); setError(''); };
  const updateName = (name: string) => { setValues(current => ({ ...current, name, ...(slugTouched ? {} : { slug: workspaceSlug(name) }) })); setError(''); };
  const changeOwnerMode = (ownerMode: WorkspaceCreateValues['ownerMode']) => { setValues(current => ({ ...current, ownerMode, newOwnerPassword: '', confirmOwnerPassword: '' })); setError(''); };

  const loadDefaults = async () => {
    const version = ++loadVersion.current;
    setLoading(true); setLoadError(''); setDefaults(null);
    try {
      const [response, roles] = await Promise.all([admin.get<{ settings: unknown }>('/settings'), admin.get<{ rolePolicy: RolePolicy; capabilities: string[] }>('/catalogue')]);
      const next = readWorkspaceDefaults(response.settings);
      if (!mounted.current || version !== loadVersion.current) return;
      setDefaults(next);
      setRoleCapabilities(roles.capabilities);
      setValues(current => ({ ...current, rolePolicy: current.rolePolicy || roles.rolePolicy }));
      setValues(current => ({ ...current, timezone: current.timezone || next.defaultTimezone, trialDays: current.trialDays || String(next.trialDays) }));
    } catch (error) {
      if (mounted.current && version === loadVersion.current) setLoadError(error instanceof Error ? error.message : 'Unable to load workspace defaults.');
    } finally { if (mounted.current && version === loadVersion.current) setLoading(false); }
  };

  useEffect(() => {
    mounted.current = true;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    formRef.current?.focus();
    loadDefaults();
    return () => { mounted.current = false; loadVersion.current++; previouslyFocused?.focus(); };
  }, []);

  const focusField = (field?: string) => {
    window.setTimeout(() => { if (mounted.current && field) formRef.current?.querySelector<HTMLElement>(`#workspace-create-${field}`)?.focus(); }, 0);
  };
  const validate = (onlyStep?: WorkspaceStep) => {
    if (!context) { setError('Load platform defaults before creating a workspace.'); return false; }
    const problem = validateWorkspaceCreate(values, context, onlyStep);
    if (!problem) { setError(''); return true; }
    setStep(problem.step); setError(problem.message); focusField(problem.field); return false;
  };
  const nextStep = () => { if (validate(step)) setStep(WORKSPACE_STEPS[Math.min(WORKSPACE_STEPS.indexOf(step) + 1, WORKSPACE_STEPS.length - 1)]); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving.current || loading || !context) return;
    if (!confirmed.current && step !== 'Review') { nextStep(); return; }
    if (!confirmed.current && !validate()) return;
    saving.current = true; setBusy(true); setError('');
    try {
      if (!confirmed.current) {
        await admin.post('/workspaces', createWorkspacePayload(values, context));
        // Once POST succeeds, a refresh failure must never create the business a second time.
        confirmed.current = true;
        if (mounted.current) { setCreated(true); setValues(current => ({ ...current, newOwnerPassword: '', confirmOwnerPassword: '' })); }
      }
      await onSaved();
    } catch (error) {
      if (mounted.current) setError(confirmed.current ? `The workspace was created. Refreshing the list failed: ${error instanceof Error ? error.message : 'please try refreshing again.'}` : error instanceof Error ? error.message : 'Unable to create the workspace.');
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const trapFocus = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...(formRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])];
    if (!nodes.length) { event.preventDefault(); formRef.current?.focus(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === formRef.current)) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === formRef.current)) { event.preventDefault(); first.focus(); }
  };
  const expiryDescription = values.expiryMode === 'inherit' ? defaults?.trialDays ? `Platform default: ${defaults.trialDays} days from creation` : 'Platform default: no automatic expiry' : values.expiryMode === 'none' ? 'No expiry' : values.expiryMode === 'trial' ? Number(values.trialDays) ? `${values.trialDays} days from creation` : 'No expiry (0 trial days)' : Number.isFinite(new Date(values.subscriptionEndsAt).getTime()) ? `${new Date(values.subscriptionEndsAt).toLocaleString()} (your local time) · ${new Date(values.subscriptionEndsAt).toISOString()}` : 'Choose a date and time';
  const planDescription = values.plan === 'inherit' ? `Platform default: ${defaults?.defaultPlan ? defaultPlan?.name || 'Unavailable plan' : 'No plan restriction'}` : values.plan === 'none' ? 'No plan restriction' : chosenPlan?.name || 'Unavailable plan';

  return <div className="modal-backdrop"><form ref={formRef} className="admin-dialog workspace-create-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-create-heading" aria-describedby="workspace-create-intro" tabIndex={-1} onKeyDown={trapFocus} onSubmit={submit} noValidate>
    <div className="admin-dialog-header"><div><h2 id="workspace-create-heading"><Building2 size={23} aria-hidden="true"/> Create business / workspace</h2><p id="workspace-create-intro" className="workspace-create-intro">Set up the owner, business details, access and limits before creating the workspace.</p></div><button type="button" disabled={busy} aria-label="Close create workspace" onClick={onClose}><X size={20}/></button></div>
    <nav className="workspace-create-steps" aria-label="Workspace setup steps">{WORKSPACE_STEPS.map((item, index) => <button key={item} type="button" className={item === step ? 'active' : ''} aria-current={item === step ? 'step' : undefined} disabled={loading || Boolean(loadError) || disabled} onClick={() => { setStep(item); setError(''); }}><span>{index + 1}</span>{item}</button>)}</nav>
    <div className="workspace-create-body">
      {loading ? <div className="workspace-create-loading" role="status"><RefreshCw size={22} aria-hidden="true"/> Loading your platform’s workspace defaults...</div> : loadError ? <div className="workspace-create-loading"><p className="admin-error" role="alert">{loadError}</p><button type="button" className="outline-reference" onClick={loadDefaults}><RefreshCw size={17}/> Retry loading defaults</button><p className="workspace-create-help">Creation is disabled until the platform defaults are available.</p></div> : <>
        {step === 'Business' && <><h3>Business details</h3><p className="workspace-create-help">Create the business and its owner login together, or select an existing account. Other team members can be added later.</p><div className="workspace-create-grid">
          <label className="admin-field"><span>Workspace name <span aria-hidden="true">*</span></span><input id="workspace-create-name" value={values.name} disabled={disabled} required maxLength={120} placeholder="Your business name" onChange={event => updateName(event.target.value)}/></label>
          <label className="admin-field"><span>Business identifier</span><input id="workspace-create-slug" value={values.slug} disabled={disabled} minLength={3} maxLength={60} placeholder="your-business" onChange={event => { setSlugTouched(true); update('slug', event.target.value); }}/><small>Unique lowercase letters, numbers and hyphens. Automatically suggested from the business name; blank lets the server assign one.</small></label>
          <label className="admin-field"><span>Business email</span><input id="workspace-create-businessEmail" type="email" value={values.businessEmail} disabled={disabled} maxLength={200} placeholder="business@example.com (optional)" onChange={event => update('businessEmail', event.target.value)}/><small>Business contact address; separate from the owner’s login email.</small></label>
          <label className="admin-field"><span>Business phone</span><input id="workspace-create-businessPhone" type="tel" value={values.businessPhone} disabled={disabled} maxLength={32} placeholder="+91 98765 43210 (optional)" onChange={event => update('businessPhone', event.target.value)}/><small>Contact number only. This does not configure a WhatsApp sender.</small></label>
          <label className="admin-field"><span>Timezone <span aria-hidden="true">*</span></span><input id="workspace-create-timezone" value={values.timezone} disabled={disabled} maxLength={100} required list="workspace-create-timezones" onChange={event => update('timezone', event.target.value)}/><datalist id="workspace-create-timezones"><option value={defaults?.defaultTimezone}/><option value="UTC"/><option value="Asia/Kolkata"/><option value="America/New_York"/><option value="Europe/London"/></datalist><small>Platform default: {defaults?.defaultTimezone}. Use a valid IANA timezone.</small></label>
          <label className="admin-field"><span>Business support email</span><input id="workspace-create-supportEmail" type="email" value={values.supportEmail} disabled={disabled} maxLength={200} placeholder={ownerEmail || 'Uses the owner’s email if blank'} onChange={event => update('supportEmail', event.target.value)}/><small>Leave blank to use {ownerEmail || 'the owner’s email'}.</small></label>
        </div><label className="admin-field"><span>Business description</span><textarea id="workspace-create-businessDescription" value={values.businessDescription} disabled={disabled} maxLength={3000} rows={3} placeholder="What does this business do? (optional)" onChange={event => update('businessDescription', event.target.value)}/></label>
          <h3>Owner login</h3><label className="admin-field"><span>Owner account setup</span><select id="workspace-create-ownerMode" value={values.ownerMode} disabled={disabled} onChange={event => changeOwnerMode(event.target.value as WorkspaceCreateValues['ownerMode'])}><option value="new">Create owner login</option><option value="existing">Use registered owner</option></select><small>The owner manages this business. You do not need to create a user first when creating a new login here.</small></label>
          {values.ownerMode === 'existing' ? <label className="admin-field"><span>Registered owner <span aria-hidden="true">*</span></span><select id="workspace-create-owner" value={values.owner} disabled={disabled} required onChange={event => update('owner', event.target.value)}><option value="">Select an active registered account</option>{activeUsers.map(user => <option key={user._id} value={user._id}>{user.name || user.email || user._id}{user.name && user.email ? ` (${user.email})` : ''}</option>)}</select><small>{activeUsers.length ? 'Their existing login stays unchanged. They receive the workspace owner role.' : 'No active registered accounts. Choose Create owner login instead.'}</small></label> : <div className="workspace-create-grid">
            <label className="admin-field"><span>Owner name <span aria-hidden="true">*</span></span><input id="workspace-create-newOwnerName" value={values.newOwnerName} disabled={disabled} required maxLength={80} autoComplete="name" onChange={event => update('newOwnerName', event.target.value)}/></label>
            <label className="admin-field"><span>Owner login email <span aria-hidden="true">*</span></span><input id="workspace-create-newOwnerEmail" type="email" value={values.newOwnerEmail} disabled={disabled} required maxLength={200} autoComplete="off" onChange={event => update('newOwnerEmail', event.target.value)}/><small>Must not already belong to an account. The owner signs in using this email.</small></label>
            <label className="admin-field"><span>Initial password <span aria-hidden="true">*</span></span><input id="workspace-create-newOwnerPassword" type="password" value={values.newOwnerPassword} disabled={disabled} required minLength={defaults?.passwordMinLength || 10} autoComplete="new-password" onChange={event => update('newOwnerPassword', event.target.value)}/><small>At least {defaults?.passwordMinLength || 10} characters with uppercase, lowercase and a number; maximum 72 UTF-8 bytes.</small></label>
            <label className="admin-field"><span>Confirm password <span aria-hidden="true">*</span></span><input id="workspace-create-confirmOwnerPassword" type="password" value={values.confirmOwnerPassword} disabled={disabled} required autoComplete="new-password" onChange={event => update('confirmOwnerPassword', event.target.value)}/><small>Share the initial login securely with the owner. It will not be shown after creation.</small></label>
          </div>}
        </>}
        {step === 'Access & plan' && <>{values.rolePolicy && <RoleAccessFields policy={values.rolePolicy} capabilities={roleCapabilities} disabled={disabled} onChange={value => update('rolePolicy', value)}/>}<h3>Plan and access</h3><div className="workspace-create-grid">
          <label className="admin-field"><span>Assigned plan</span><select id="workspace-create-plan" value={values.plan} disabled={disabled} onChange={event => update('plan', event.target.value)}><option value="inherit">Use platform default — {defaults?.defaultPlan ? defaultPlan?.name || 'Unavailable plan' : 'No plan restriction'}</option><option value="none">No plan restriction</option>{activePlans.map(plan => <option key={plan._id} value={plan._id}>{plan.name || plan._id}</option>)}</select><small>Choosing a plan controls its allowed modules and inherited capacity limits. No payment is collected here.</small></label>
          <label className="admin-field"><span>Subscription expiry</span><select id="workspace-create-expiryMode" value={values.expiryMode} disabled={disabled} onChange={event => update('expiryMode', event.target.value as WorkspaceCreateValues['expiryMode'])}><option value="inherit">Use platform default — {defaults?.trialDays ? `${defaults.trialDays} days` : 'No automatic expiry'}</option><option value="none">No expiry</option><option value="trial">Set trial length</option><option value="date">Set exact expiry date and time</option></select><small>Expired workspaces cannot access the platform until an administrator extends the subscription.</small></label>
          {values.expiryMode === 'trial' && <label className="admin-field"><span>Trial length (days)</span><input id="workspace-create-trialDays" type="number" min={0} max={365} step={1} value={values.trialDays} disabled={disabled} onChange={event => update('trialDays', event.target.value)}/><small>0 means no expiry; otherwise count from workspace creation.</small></label>}
          {values.expiryMode === 'date' && <label className="admin-field"><span>Expiry date and time (your local time)</span><input id="workspace-create-subscriptionEndsAt" type="datetime-local" value={values.subscriptionEndsAt} disabled={disabled} onChange={event => update('subscriptionEndsAt', event.target.value)}/><small>This exact instant is stored in UTC. It uses your device’s timezone, not the business timezone.</small></label>}
        </div><div className="workspace-create-grid"><label className="workspace-create-toggle"><input type="checkbox" checked={values.isActive} disabled={disabled} onChange={event => update('isActive', event.target.checked)}/><span><b>Workspace active</b><small>Turn off to create the workspace in a suspended state.</small></span></label><label className="workspace-create-toggle"><input type="checkbox" checked={values.sendingEnabled} disabled={disabled} onChange={event => update('sendingEnabled', event.target.checked)}/><span><b>WhatsApp sending allowed</b><small>{defaults?.sendingEnabled === false ? 'Platform sending is currently paused and still takes priority.' : 'Requires provider credentials and the required enabled modules.'}</small></span></label></div>
          <h3>Workspace modules</h3><p className="workspace-create-help">Checked modules are allowed if included in the assigned plan. Uncheck a module to block it. Without a plan restriction, all checked modules are available. Platform blocks still apply.</p><div className="workspace-create-feature-grid">{features.map(feature => {
            const restriction = defaults?.disabledFeatures.includes(feature) ? 'Blocked by platform' : chosenPlan?.features && !chosenPlan.features.includes(feature) ? 'Not included in the assigned plan' : '';
            return <label key={feature}><input type="checkbox" disabled={disabled} checked={!values.disabledFeatures.includes(feature)} onChange={event => update('disabledFeatures', event.target.checked ? values.disabledFeatures.filter(item => item !== feature) : [...values.disabledFeatures, feature])}/><span>{title(feature)}{restriction && <small>{restriction}</small>}</span></label>;
          })}</div></>}
        {step === 'Capacity' && <><h3>People / role seat limits</h3><p className="workspace-create-help">Set how many business admins, agents and supervisors can belong to this business. Blank means unlimited for that role; 0 blocks new members in that role. Saved memberships count even if an account is suspended. The owner is excluded from these role limits but counts toward the total team-member capacity below.</p><div className="workspace-create-grid">{SEAT_LIMIT_KEYS.map(key => <label className="admin-field" key={key}><span>{seatTitles[key]}</span><input id={`workspace-create-seat-${key}`} type="number" min={0} max={100000} step={1} value={values.seatLimits[key] || ''} disabled={disabled} placeholder="No role limit" onChange={event => update('seatLimits', { ...values.seatLimits, [key]: event.target.value })}/><small>Leave blank for unlimited.</small></label>)}</div>
          <h3>Capacity overrides <small>(optional)</small></h3><p className="workspace-create-help">Leave a limit blank to inherit the assigned plan. Without a plan limit it is unlimited. Choose Unlimited to override a plan limit; 0 blocks new records. The owner is included in team-member capacity.</p><div className="workspace-create-grid workspace-create-limits">{CAPACITY_KEYS.map(key => {
          const inherited = chosenPlan?.limits?.[key];
          return <div className="workspace-create-limit" key={key}><label className="admin-field"><span>{title(key)}</span><input id={`workspace-create-limit-${key}`} type="number" min={0} step={1} value={values.limits[key] || ''} disabled={disabled || values.unlimited.includes(key)} placeholder={inherited == null ? 'Inherit: unlimited' : `Inherit: ${inherited}`} onChange={event => update('limits', { ...values.limits, [key]: event.target.value })}/></label><label className="workspace-create-unlimited"><input type="checkbox" disabled={disabled} checked={values.unlimited.includes(key)} onChange={event => update('unlimited', event.target.checked ? [...values.unlimited, key] : values.unlimited.filter(item => item !== key))}/> Unlimited</label></div>;
        })}</div><label className="admin-field"><span>Private administrator notes</span><textarea id="workspace-create-adminNotes" value={values.adminNotes} disabled={disabled} maxLength={3000} rows={3} onChange={event => update('adminNotes', event.target.value)} placeholder="Internal setup or account notes (optional)"/><small>Visible to superadmins only; not business team members.</small></label></>}
        {step === 'Review' && <><h3>Review before creating</h3><p className="workspace-create-help">These settings are saved together with the new workspace and its owner membership{values.ownerMode === 'new' ? ', including the new owner login' : ''}.</p><dl className="workspace-create-review">
          <div><dt>Workspace</dt><dd>{values.name.trim() || 'Not entered'}</dd></div><div><dt>Business identifier</dt><dd>{values.slug.trim() || 'Automatically assigned by the server'}</dd></div><div><dt>Business email</dt><dd>{values.businessEmail.trim() || 'None'}</dd></div><div><dt>Business phone</dt><dd>{values.businessPhone.trim() || 'None'}</dd></div>
          <div><dt>Owner setup</dt><dd>{values.ownerMode === 'new' ? 'Create new owner login' : 'Use existing registered login'}</dd></div><div><dt>Owner</dt><dd>{values.ownerMode === 'new' ? `${values.newOwnerName.trim() || 'Not entered'} (${values.newOwnerEmail.trim() || 'Email not entered'})` : owner ? `${owner.name || owner.email} (${owner.email || owner._id})` : 'Not selected'}</dd></div>
          <div><dt>Timezone</dt><dd>{values.timezone || 'Not entered'}</dd></div><div><dt>Support email</dt><dd>{values.supportEmail.trim() || ownerEmail || 'Not entered'}</dd></div><div><dt>Plan</dt><dd>{planDescription}</dd></div><div><dt>Workspace status</dt><dd>{values.isActive ? 'Active' : 'Suspended'}</dd></div><div><dt>WhatsApp sending</dt><dd>{values.sendingEnabled ? 'Allowed, subject to platform/provider setup' : 'Paused'}</dd></div><div><dt>Subscription expiry</dt><dd>{expiryDescription}</dd></div>
          <div><dt>Available modules</dt><dd>{effectiveFeatures.length ? effectiveFeatures.map(title).join(', ') : 'No modules available under the selected restrictions'}</dd></div>
          <div><dt>Business may create</dt><dd>{values.rolePolicy?.creatableRoles.map(role=>businessRoleNames[role]).join(', ') || 'No roles'}</dd></div><div><dt>Role seat limits</dt><dd>{SEAT_LIMIT_KEYS.map(key => `${seatTitles[key]}: ${values.seatLimits[key]?.trim() || 'Unlimited'}`).join(' · ')}</dd></div><div><dt>Capacity overrides</dt><dd>{CAPACITY_KEYS.some(key => values.unlimited.includes(key) || values.limits[key]?.trim()) ? CAPACITY_KEYS.filter(key => values.unlimited.includes(key) || values.limits[key]?.trim()).map(key => `${title(key)}: ${values.unlimited.includes(key) ? 'Unlimited' : values.limits[key]}`).join(' · ') : 'All limits inherit the plan / unlimited defaults'}</dd></div><div><dt>Private notes</dt><dd>{values.adminNotes.trim() || 'None'}</dd></div></dl>
          {values.expiryMode === 'date' && Number.isFinite(new Date(values.subscriptionEndsAt).getTime()) && new Date(values.subscriptionEndsAt).getTime() <= Date.now() && <p className="workspace-create-note">The selected expiry is in the past. This workspace will start with an expired subscription.</p>}
          {!values.isActive && <p className="workspace-create-note">This workspace will be suspended; its business team cannot access it until you activate it.</p>}
        </>}
        <p className="workspace-create-note">Test wallet balances/prices and Smartping provider credentials are managed separately. Creating a workspace does not connect WhatsApp or collect a payment.</p>
      </>}
      {created && <p className="workspace-create-note" role="status"><Check size={18} aria-hidden="true"/> Workspace created successfully. Refresh the list or close this dialog.</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
    </div>
    <div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={onClose}>{created ? 'Close' : 'Cancel'}</button><div className="workspace-create-navigation">{step !== 'Business' && !created && <button type="button" disabled={loading || Boolean(loadError) || busy} onClick={() => { setStep(WORKSPACE_STEPS[WORKSPACE_STEPS.indexOf(step) - 1]); setError(''); }}><ChevronLeft size={16} aria-hidden="true"/> Back</button>}{step === 'Review' || created ? <button className="green-reference" type="submit" disabled={loading || Boolean(loadError) || busy}>{busy ? created ? 'Refreshing...' : 'Creating...' : created ? 'Refresh workspace list' : 'Create workspace'}</button> : <button className="green-reference" type="button" disabled={loading || Boolean(loadError) || busy} onClick={nextStep}>Next <ChevronRight size={16} aria-hidden="true"/></button>}</div></div>
  </form></div>;
}
