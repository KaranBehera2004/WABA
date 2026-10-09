import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { superadminApi as admin } from '../lib/api';

type Plan = { name: string; monthlyPrice: number; currency: string; description?: string; features: string[]; limits?: Record<string, number | null>; isCustom?: boolean };
type Configuration = { workspace: { _id: string; name: string }; basePlan: Plan | null; customPlan: Plan | null; effectivePlan: Plan | null; features: string[]; capacityKeys: string[]; overrides: Record<string, number | null>; seatLimits: Record<string, number | null>; activityPricing: { currency: 'INR'; mode: 'test'; units: Record<string, string>; defaultPricesPaise: Record<string, number>; pricesPaise: Record<string, number>; source: 'default' | 'custom' } };
type Props = { workspaceId: string; onBack: () => void; onBusy: (busy: boolean) => void; onSaved: (message: string) => Promise<void> };
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const fieldModule = (key: string) => key === 'members' ? 'team' : key === 'messages' ? 'conversations' : key;
const priceLabel = (plan: Plan | null) => plan ? `${plan.currency} ${plan.monthlyPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / month` : 'No plan restriction';

export default function WorkspaceCustomPlan({ workspaceId, onBack, onBusy, onSaved }: Props) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [name, setName] = useState(''); const [price, setPrice] = useState(''); const [currency, setCurrency] = useState('INR'); const [description, setDescription] = useState('');
  const [features, setFeatures] = useState<string[]>([]); const [limits, setLimits] = useState<Record<string, string>>({});
  const [activityPrices, setActivityPrices] = useState<Record<string, string>>({});
  const [restore, setRestore] = useState(false); const saving = useRef(false);
  const moduleIncluded = (key: string) => features.includes(fieldModule(key));
  const load = async () => {
    setLoading(true); setError('');
    try {
      const data = await admin.get<Configuration>(`/workspaces/${workspaceId}/custom-plan`);
      if (!data.activityPricing || data.activityPricing.currency !== 'INR' || !data.activityPricing.pricesPaise || Object.values(data.activityPricing.pricesPaise).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Activity pricing could not be loaded. Retry before saving the custom plan.');
      const plan = data.effectivePlan;
      setConfiguration(data); setName(data.customPlan?.name || `${data.workspace.name} custom plan`.slice(0, 100)); setPrice(String(plan?.monthlyPrice ?? 0)); setCurrency(plan?.currency || 'INR'); setDescription(plan?.description || ''); setFeatures(plan?.features || data.features);
      setLimits(Object.fromEntries(data.capacityKeys.map(key => [key, plan?.limits?.[key] == null ? '' : String(plan.limits[key])])));
      setActivityPrices(Object.fromEntries(Object.entries(data.activityPricing.pricesPaise).map(([key, value]) => [key, (value / 100).toFixed(2)])));
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to load plan configuration.'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [workspaceId]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!configuration || saving.current) return;
    saving.current = true; setBusy(true); onBusy(true); setError('');
    try {
      if (restore) {
        await admin.post(`/workspaces/${workspaceId}/custom-plan/restore`, { confirm: true });
        await onSaved('Custom plan removed. This business uses its assigned standard plan again.');
      } else {
        const amount = Number(price);
        if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) throw new Error('Enter a non-negative monthly price with at most two decimal places.');
        const capacities = Object.fromEntries(configuration.capacityKeys.map(key => {
          const value = limits[key].trim(); const amount = value === '' ? null : Number(value);
          if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error(`${label(key)} limit must be a whole non-negative number, or blank for unlimited.`);
          return [key, amount];
        }));
        const activityPricesPaise = Object.fromEntries(Object.entries(activityPrices).map(([activity, value]) => {
          if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) throw new Error(`${label(activity)} price must be a non-negative amount with at most two decimal places.`);
          const paise = Math.round(Number(value) * 100);
          if (!Number.isSafeInteger(paise) || paise > 1000000) throw new Error(`${label(activity)} price must be at most INR 10,000 per unit.`);
          return [activity, paise];
        }));
        await admin.put(`/workspaces/${workspaceId}/custom-plan`, { name: name.trim(), monthlyPrice: amount, currency, description: description.trim(), features, limits: capacities, activityPricesPaise });
        await onSaved('Custom plan and activity pricing applied to this business only.');
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to save the custom plan.'); }
    finally { saving.current = false; setBusy(false); onBusy(false); }
  };
  return <section className="workspace-custom-plan">
    <button className="workspace-management-back" disabled={busy} onClick={onBack}><ArrowLeft size={15}/> Back to workspace management</button>
    <h3>{configuration?.customPlan ? 'Edit custom plan' : 'Set custom plan'}</h3>
    {error && <p className="admin-error" role="alert">{error}</p>}
    {loading ? <p role="status">Loading plan configuration…</p> : !configuration ? <button onClick={load}>Try again</button> : <>
      <div className="workspace-create-note"><b>Assigned standard plan: {configuration.basePlan?.name || 'Unrestricted'}</b><br/>{priceLabel(configuration.basePlan)}<br/>New businesses continue to use the platform default. This negotiated plan applies only to {configuration.workspace.name}. Saving does not collect a payment.</div>
      <form onSubmit={submit}>
        {restore ? <><h3>Restore assigned standard plan?</h3><p className="workspace-management-help">Remove this business’s negotiated price, modules and plan limits and use <b>{configuration.basePlan?.name || 'Unrestricted'}</b> again. Activity prices return to the platform defaults. Existing data, workspace overrides, account access and subscription expiry are retained.</p><div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={() => setRestore(false)}>Keep custom plan</button><button type="submit" className="green-reference" disabled={busy}>{busy ? 'Restoring…' : 'Confirm restore standard plan'}</button></div></> : <>
          <div className="workspace-create-grid workspace-custom-fields">
            <label className="admin-field">Custom plan name<input autoFocus required maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)}/></label>
            <label className="admin-field">Negotiated monthly price<input required type="number" min="0" step="0.01" disabled={busy} value={price} onChange={event => setPrice(event.target.value)}/></label>
            <label className="admin-field">Currency<select disabled={busy} value={currency} onChange={event => setCurrency(event.target.value)}>{['INR','USD','EUR'].map(value => <option key={value}>{value}</option>)}</select></label>
            <label className="admin-field">Agreement notes<textarea maxLength={1000} rows={3} disabled={busy} value={description} onChange={event => setDescription(event.target.value)}/></label>
          </div>
          <h3>Included WABA modules</h3><p className="workspace-management-help">Unchecked modules are marked as excluded in the capacity and pricing sections below, with their values retained for re-enabling. Workspace add-ons can add modules. Workspace and platform feature blocks still take priority.</p>
          <div className="admin-checkbox-grid workspace-custom-modules">{configuration.features.map(feature => <label key={feature}><input type="checkbox" disabled={busy} checked={features.includes(feature)} onChange={event => setFeatures(current => event.target.checked ? [...current, feature] : current.filter(value => value !== feature))}/>{label(feature)}</label>)}</div>
          <h3>Plan capacity limits</h3><p className="workspace-management-help">Blank means unlimited; zero prevents new records. Existing data is preserved when a limit is lowered. Existing workspace capacity overrides take priority. Business Admin and Agent seat limits remain under Business & access.</p>
          <div className="workspace-create-grid">{configuration.capacityKeys.map(key => <label className="admin-field workspace-module-field" data-excluded={!moduleIncluded(key)} key={key}>{label(key)}{!moduleIncluded(key) && <small className="workspace-module-excluded">Not included in this plan</small>}<input aria-label={`${label(key)} plan limit`} type="number" min="0" step="1" placeholder="Unlimited" disabled={busy || !moduleIncluded(key)} value={limits[key]} onChange={event => setLimits({ ...limits, [key]: event.target.value })}/>{configuration.overrides[key] !== undefined && <small className="workspace-management-help">Workspace override: {configuration.overrides[key] === null ? 'Unlimited' : configuration.overrides[key]} (takes priority)</small>}</label>)}</div>
          <h3>Custom activity pricing</h3><p className="workspace-management-help">Current pricing: <b>{configuration.activityPricing.source === 'custom' ? 'Business custom prices' : 'Platform default prices'}</b>. New businesses use the default prices. Saving these rates applies them to future activity deductions for this business only; previous charges and balances stay unchanged.</p>
          <p className="workspace-create-note">Activity prices use INR test credits, independently of the monthly subscription currency. These are platform activity rates; confirmed provider charges and real payments are separate. Zero makes an activity free.</p>
          <div className="workspace-custom-prices">{Object.keys(configuration.activityPricing.pricesPaise).map(activity => <label className="admin-field workspace-module-field" data-excluded={!moduleIncluded(activity)} key={activity}><b>{label(activity)}</b>{!moduleIncluded(activity) && <small className="workspace-module-excluded">Not included in this plan</small>}<small>{configuration.activityPricing.units[activity]} · Default INR {(configuration.activityPricing.defaultPricesPaise[activity] / 100).toFixed(2)}</small><input aria-label={`${label(activity)} custom price in INR`} required type="number" min="0" max="10000" step="0.01" disabled={busy || !moduleIncluded(activity)} value={activityPrices[activity]} onChange={event => setActivityPrices({ ...activityPrices, [activity]: event.target.value })}/></label>)}</div>
          <div className="workspace-custom-review"><b>{name || 'Custom plan'}</b><span>{currency} {Number(price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / month</span><small>Applies only to {configuration.workspace.name}</small></div>
          <div className="admin-dialog-actions">{configuration.customPlan && <button type="button" disabled={busy} onClick={() => { setError(''); setRestore(true); }}>Restore standard plan</button>}<button type="button" disabled={busy} onClick={onBack}>Cancel</button><button type="submit" disabled={busy} className="green-reference">{busy ? 'Applying…' : 'Apply custom plan'}</button></div>
        </>}
      </form>
    </>}
  </section>;
}
