import { ChevronRight } from 'lucide-react';
import type { DashboardProps } from '../RoleOverview';
export const count = (value?: number, loading = false) => loading ? '—' : (value || 0).toLocaleString();
export const ratio = (value: number, total: number) => total ? Math.round(value / total * 100) : 0;
export function PanelHeading({ title, description, action }: { title: string; description: string; action?: () => void }) {
  return <div className="role-panel-heading"><div><h2>{title}</h2><p>{description}</p></div>{action && <button aria-label={'View ' + title.toLowerCase()} onClick={action}><ChevronRight size={19}/></button>}</div>;
}
export function PeriodSelect({ period, setPeriod }: Pick<DashboardProps, 'period' | 'setPeriod'>) {
  return <select aria-label="Dashboard date range" className="secondary-button" value={period} onChange={event => setPeriod(event.target.value)}><option>Last 7 days</option><option>Last 30 days</option><option>Last 90 days</option></select>;
}
export function openInbox(navigate: DashboardProps['navigate'], scope: string, id?: string) {
  const url = new URL(window.location.href); url.searchParams.set('inbox', scope);
  if (id) url.searchParams.set('conversation', id); else url.searchParams.delete('conversation');
  window.history.replaceState(window.history.state, '', url); navigate('Inbox');
}
export type CampaignResult = { _id: string; name: string; status: string; sent?: number; delivered?: number; read?: number; scheduledAt?: string };
export function CampaignTable({ items, loading, error, onOpen }: { items: CampaignResult[]; loading: boolean; error: string; onOpen: (id: string) => void }) {
  return <div className="dashboard-table-wrap">{error ? <p role="alert" className="role-empty">{error}</p> : loading ? <p className="role-empty">Loading broadcasts…</p> : !items.length ? <p className="role-empty">No broadcasts recorded yet.</p> : <table className="dashboard-table"><thead><tr><th>Broadcast</th><th>Status</th><th>Sent</th><th>Delivered</th><th>Read</th></tr></thead><tbody>{items.map(item => <tr key={item._id}><td><button onClick={() => onOpen(item._id)}>{item.name}</button></td><td><span className="status-tag neutral">{item.status}</span></td><td>{count(item.sent)}</td><td>{count(item.delivered)}</td><td>{count(item.read)}</td></tr>)}</tbody></table>}</div>;
}
