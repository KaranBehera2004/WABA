import { Permission } from '../lib/WorkspaceAccessContext';
import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { api, type SmartpingStatus } from '../lib/api';

export default function SmartpingConnection({ onNotice }: { onNotice: (message: string) => void }) {
  const [status, setStatus] = useState<SmartpingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const refresh = () => { setBusy(true); api.smartpingStatus().then(setStatus).catch(error => onNotice(error.message)).finally(() => setBusy(false)); };
  useEffect(() => { refresh(); api.currentWorkspace().then(result => setWorkspaceId(result.workspace._id)).catch(error => onNotice(error.message)); }, []);
  const check = async () => { setBusy(true); try { const result = await api.checkSmartpingAuthentication(); onNotice(result.message); } catch (error) { onNotice(error instanceof Error ? error.message : 'Authentication failed.'); } finally { setBusy(false); } };
  return <div className="settings-form smartping-connection"><Radio size={30}/><h2>Smartping WhatsApp</h2><p>{status ? status.configured ? 'Server configuration is ready. Sending confirms authentication and acceptance.' : 'Server configuration is incomplete.' : 'Checking configuration…'}</p>
    <dl><dt>Workspace ID</dt><dd>{workspaceId || 'Loading…'}</dd><dt>Sender number</dt><dd>{status?.from || 'Not configured'}</dd><dt>Journey ID</dt><dd>{status?.journeyId || 'Not configured'}</dd><dt>Delivery callbacks</dt><dd>{status?.deliveryTracking ? 'Configured' : 'Not configured'}</dd></dl>
    {status?.missing.length ? <p className="smartping-error">Missing: {status.missing.join(', ')}</p> : null}
    <p>Ask your administrator to set the Smartping credentials, account login URL, journey ID, and sender number in server/.env. Credentials stay on the server. Restart the API after changing configuration.</p>
    <p>This document supports approved templates and delivery events. Inbound messages, free-text replies, template approval, and ad synchronization require additional Smartping documentation.</p>
    <div className="smartping-connection-actions">
      <button className="green-reference" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Refresh configuration'}</button>
      <Permission capability="integrations.manage"><button className="green-reference" disabled={busy || !status?.configured} onClick={check}>Test authentication</button></Permission>
    </div>
  </div>;
}
