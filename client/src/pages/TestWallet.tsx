import { useEffect, useRef, useState } from 'react';
import { Download, FlaskConical, RefreshCw, Wallet } from 'lucide-react';
import { api, type WalletData, type WalletDemoResult, type WalletEntry } from '../lib/api';

export const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);
export const activityName = (value: string) => value[0]?.toUpperCase() + value.slice(1);
const demoActivityLabels: Record<string, string> = { messages: 'Chat message', calls: 'Call', campaigns: 'Campaign', conversations: 'New chat conversation' };
export function WalletBalance({ data }: { data: WalletData }) {
  return <article className="test-wallet-balance"><div><span><Wallet size={19}/> Available test balance</span><strong>{money(data.wallet.balancePaise)}</strong><small>Credits are saved for this business. Refreshing does not refill the wallet.</small></div><span className="test-wallet-tag"><FlaskConical size={16}/> Test money only</span></article>;
}
export function WalletHistory({ entries }: { entries: WalletEntry[] }) {
  return <div className="test-wallet-table"><table><thead><tr><th>Date</th><th>Activity</th><th>Change</th><th>Balance after</th><th>Status</th><th>Details</th></tr></thead><tbody>{entries.length ? entries.map(entry => <tr key={entry._id}><td>{new Date(entry.createdAt).toLocaleString()}</td><td>{entry.activity ? activityName(entry.activity) : activityName(entry.kind)}</td><td className={entry.deltaPaise > 0 ? 'wallet-credit' : 'wallet-debit'}>{entry.deltaPaise > 0 ? '+' : ''}{money(entry.deltaPaise)}</td><td>{money(entry.balanceAfterPaise)}</td><td><span className={`wallet-status ${entry.status}`}>{entry.status === 'reserved' ? 'Reserved' : activityName(entry.status)}</span></td><td>{entry.reason}{entry.actor?.name && <small>By {entry.actor.name}</small>}{entry.recordId && <small>Record: {entry.recordId}</small>}</td></tr>) : <tr><td colSpan={6}>No transactions on this page.</td></tr>}</tbody></table></div>;
}
export default function TestWallet({ permissions = null, enabledFeatures = null, superadmin = false }: { permissions?: string[] | null; enabledFeatures?: string[] | null; superadmin?: boolean }) {
  const [data, setData] = useState<WalletData | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), [before, setBefore] = useState('');
  const [demoActivity, setDemoActivity] = useState('messages'), [demoBusy, setDemoBusy] = useState(false), [demoError, setDemoError] = useState(''), [demoResult, setDemoResult] = useState<WalletDemoResult | null>(null);
  const [exporting, setExporting] = useState(false), [exportError, setExportError] = useState(''), [exportNotice, setExportNotice] = useState('');
  const exportController = useRef<AbortController | null>(null);
  const demoKey = useRef('');
  const mounted = useRef(false), walletReadVersion = useRef(0);
  const scope = new URL(window.location.href).searchParams.get('workspace') || '';
  const sessionToken = localStorage.getItem('waba_token');
  const currentContext = () => mounted.current && localStorage.getItem('waba_token') === sessionToken && (new URL(window.location.href).searchParams.get('workspace') || '') === scope;
  const allowedDemo = (activity: string) => superadmin || Boolean(enabledFeatures?.includes(activity === 'messages' ? 'conversations' : activity) && permissions?.includes(activity === 'messages' ? 'conversations.send' : `${activity}.create`));
  const demoActivityLabel = (activity: string) => demoActivityLabels[activity] || activityName(activity);
  useEffect(() => {
    mounted.current = true; ++walletReadVersion.current; demoKey.current = '';
    setData(null); setDemoResult(null); setDemoError(''); setDemoBusy(false); setBefore('');
    setExporting(false); setExportError(''); setExportNotice('');
    return () => { mounted.current = false; ++walletReadVersion.current; exportController.current?.abort(); exportController.current = null; };
  }, [scope, sessionToken]);
  const exportHistory = async () => {
    if (exportController.current) return;
    const controller = new AbortController(); exportController.current = controller;
    setExporting(true); setExportError(''); setExportNotice('');
    try {
      const { blob, fileName } = await api.downloadWalletHistory(controller.signal);
      if (!currentContext() || controller.signal.aborted || exportController.current !== controller) return;
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a'); link.href = url; link.download = fileName;
        document.body.appendChild(link); link.click(); link.remove();
        setExportNotice('Your full transaction history CSV download has started.');
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) {
      if (currentContext() && !controller.signal.aborted && exportController.current === controller) setExportError(error instanceof Error ? error.message : 'Unable to export transaction history.');
    } finally {
      if (exportController.current === controller) { exportController.current = null; if (currentContext()) setExporting(false); }
    }
  };
  const runDemo = async () => {
    if (demoBusy || !allowedDemo(demoActivity)) return;
    setDemoBusy(true); setDemoError(''); setDemoResult(null);
    // Keep this key after an uncertain failure so retrying cannot charge twice.
    demoKey.current ||= crypto.randomUUID();
    try {
      const result = await api.demoWalletActivity(demoActivity, demoKey.current);
      if (!currentContext()) return;
      ++walletReadVersion.current;
      setDemoResult(result);
      setData(current => current ? { ...current, wallet: { ...current.wallet, balancePaise: result.balanceAfterPaise } } : current);
      setBefore('');
      const historyVersion = ++walletReadVersion.current;
      try { const latest = await api.wallet(); if (currentContext() && historyVersion === walletReadVersion.current) { setData(latest); setError(''); } }
      catch { if (currentContext() && historyVersion === walletReadVersion.current) setError('The demo result is saved. Refresh to load the latest transaction history.'); }
      finally { if (currentContext() && historyVersion === walletReadVersion.current) setBusy(false); }
      // Only start a new action after the previous request is confirmed complete.
      if (currentContext()) demoKey.current = '';
    } catch (error) { if (currentContext()) setDemoError(error instanceof Error ? error.message : 'Unable to run the demo activity.'); }
    finally { if (currentContext()) setDemoBusy(false); }
  };
  const load = async () => { const version = ++walletReadVersion.current; setBusy(true); setError(''); try { const latest = await api.wallet(before); if (currentContext() && version === walletReadVersion.current) setData(latest); } catch (error) { if (currentContext() && version === walletReadVersion.current) setError(error instanceof Error ? error.message : 'Unable to load wallet.'); } finally { if (currentContext() && version === walletReadVersion.current) setBusy(false); } };
  useEffect(() => {
    let active = true;
    const refresh = async () => { const version = ++walletReadVersion.current; try { const result = await api.wallet(before); if (active && currentContext() && version === walletReadVersion.current) { setData(result); setError(''); } } catch (error) { if (active && currentContext() && version === walletReadVersion.current) setError(error instanceof Error ? error.message : 'Unable to load wallet.'); } finally { if (active && currentContext() && version === walletReadVersion.current) setBusy(false); } };
    setBusy(true); refresh(); const timer = window.setInterval(refresh, 30000); window.addEventListener('waba:wallet-changed', refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('waba:wallet-changed', refresh); };
  }, [before, scope, sessionToken]);
  return <section className="test-wallet-page"><div className="test-wallet-heading"><div><h1>Business wallet</h1><p>Testing credits and activity usage for your workspace.</p></div><button className="outline-reference" disabled={busy || demoBusy} onClick={load}><RefreshCw size={17}/> Refresh</button></div><p className="test-wallet-warning"><FlaskConical size={19}/> This wallet uses dummy INR credits only. It cannot receive, withdraw, or charge real money.</p>{error && <p className="test-wallet-error" role="alert">{error}</p>}{data ? <><WalletBalance data={data}/>
    {Object.keys(data.settings.prices).some(allowedDemo) && <article className="test-wallet-panel wallet-demo-panel"><h2><FlaskConical size={19}/> Demo activity tester</h2><p>Run one test activity to see the wallet deduction. This does not send WhatsApp messages, make calls, or create real provider records.</p>
      <div className="wallet-demo-controls"><label htmlFor="wallet-demo-activity">Activity<select id="wallet-demo-activity" value={demoActivity} disabled={demoBusy} onChange={event => { setDemoActivity(event.target.value); demoKey.current = ''; setDemoError(''); setDemoResult(null); }}>{Object.keys(data.settings.prices).map(activity => <option key={activity} value={activity} disabled={!allowedDemo(activity)}>{demoActivityLabel(activity)}{!allowedDemo(activity) ? ' (not permitted)' : ''}</option>)}</select></label><div className="wallet-demo-price"><span>Price for one activity</span><strong>{money(data.settings.prices[demoActivity] ?? 0)}</strong></div><button className="new-campaign" disabled={demoBusy || busy || !allowedDemo(demoActivity)} onClick={runDemo}><FlaskConical size={17}/>{demoBusy ? 'Running demo...' : demoError ? 'Retry demo activity' : 'Run demo activity'}</button></div>
      {!allowedDemo(demoActivity) && <p>This activity is not enabled for your workspace role. Choose a permitted activity or contact your administrator.</p>}
      {!data.settings.deductionsEnabled && <p>Deductions are paused by the superadmin. Demo activities will not deduct money.</p>}
      {demoError && <p className="test-wallet-error" role="alert">{demoError}</p>}
      {demoResult && <div className="wallet-demo-result" role="status"><b>{demoActivityLabel(demoResult.activity)} demo {demoResult.duplicate ? 'already recorded' : 'complete'}</b><span>{demoResult.duplicate ? 'No additional deduction.' : demoResult.chargedPaise === 0 ? 'No charge for this activity.' : `Deducted: ${money(demoResult.chargedPaise)}`}</span><strong>New balance: {money(demoResult.balanceAfterPaise)}</strong>{demoResult.reason && <small>{demoResult.reason}</small>}</div>}
    </article>}
    <article className="test-wallet-panel"><h2>Activity prices</h2><p>{data.settings.pricingSource === 'custom' ? 'Custom business pricing.' : 'Default platform pricing.'} </p><p>{data.settings.deductionsEnabled ? 'Deductions are enabled.' : 'Deductions are paused by the superadmin.'} Prices are set by the superadmin and apply to future activities.</p><div className="test-wallet-price-grid">{Object.entries(data.settings.prices).map(([activity, price]) => <div key={activity}><span><b>{activityName(activity)}</b><small>{data.units[activity]}</small></span><strong>{money(price)}</strong></div>)}</div><p>Page views, edits, downloads, existing records, and delivery callbacks are free. Calls, bots and ads are priced per created record, not live provider execution.</p></article><article className="test-wallet-panel"><div className="wallet-history-heading"><h2>Transaction history</h2><button type="button" className="outline-reference" disabled={exporting} onClick={exportHistory} title="Download all wallet transactions as an Excel-compatible CSV" aria-busy={exporting}><Download size={17} aria-hidden="true"/>{exporting ? 'Exporting...' : 'Export history'}</button></div><p>Each deduction stores its activity, price and resulting balance. Message reservations already reduce the available balance; uncertain sends remain reserved until provider confirmation or administrator review.</p>{exportError && <p className="test-wallet-error" role="alert">{exportError}</p>}{exportNotice && <p className="wallet-export-notice" role="status">{exportNotice}</p>}<WalletHistory entries={data.entries || []}/><div className="test-wallet-pagination"><button className="outline-reference" disabled={!before || busy || demoBusy} onClick={() => setBefore('')}>Latest transactions</button><button className="outline-reference" disabled={!data.nextCursor || busy || demoBusy} onClick={() => setBefore(data.nextCursor || '')}>Older transactions</button></div></article></> : busy && !error ? <p>Loading test wallet...</p> : null}</section>;
}
