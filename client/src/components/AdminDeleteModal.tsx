import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Archive, Check, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { superadminApi as admin } from '../lib/api';
import { buildDeletionPreviewPayload, createDeletionExecutePayload, deletionLabel, deletionResultSummary, readDeletionPreview, readDeletionResult, validateDeletionConfirmation, type DeletionPreview, type DeletionResource, type DeletionResult, type DeletionScope } from '../lib/adminDeletion';

type Props = { resource: DeletionResource; scope: DeletionScope; ids?: string[]; onClose: () => void; onDeleted: (result: DeletionResult) => Promise<void> };

export default function AdminDeleteModal({ resource, scope, ids, onClose, onDeleted }: Props) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeletionResult | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const loadVersion = useRef(0);
  const saving = useRef(false);
  const confirmed = useRef(false);
  const idsKey = ids?.join(',') || '';

  const loadPreview = async () => {
    if (saving.current || confirmed.current) return;
    const version = ++loadVersion.current;
    setLoading(true); setError(''); setPreview(null); setConfirmation('');
    try {
      const response = await admin.post<unknown>('/deletions/preview', buildDeletionPreviewPayload(resource, scope, ids));
      const next = readDeletionPreview(response, resource, scope);
      if (mounted.current && version === loadVersion.current) { setPreview(next); setUnconfirmed(false); }
    } catch (caught) { if (mounted.current && version === loadVersion.current) setError(caught instanceof Error ? caught.message : 'Unable to preview deletion. No deletion has been requested by this preview.'); }
    finally { if (mounted.current && version === loadVersion.current) setLoading(false); }
  };
  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    formRef.current?.focus();
    return () => { mounted.current = false; loadVersion.current++; previous?.focus(); };
  }, []);
  useEffect(() => { loadPreview(); }, [resource, scope, idsKey]);

  const refreshList = async (savedResult: DeletionResult) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try { await onDeleted(savedResult); }
    catch (caught) { if (mounted.current) setError(`Deletion completed, but refreshing the list failed: ${caught instanceof Error ? caught.message : 'please retry refreshing the list.'}`); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving.current || loading) return;
    if (confirmed.current) { if (result) await refreshList(result); return; }
    if (unconfirmed) return;
    const problem = validateDeletionConfirmation(preview, confirmation);
    if (problem) { setError(problem); formRef.current?.querySelector<HTMLElement>('#admin-delete-confirmation')?.focus(); return; }
    saving.current = true; setBusy(true); setError('');
    try {
      const response = await admin.post<unknown>('/deletions/execute', createDeletionExecutePayload(preview, confirmation));
      const savedResult = readDeletionResult(response, resource);
      confirmed.current = true;
      if (mounted.current) { setResult(savedResult); setConfirmation(''); }
      await onDeleted(savedResult);
    } catch (caught) {
      if (mounted.current) {
        if (confirmed.current) setError(`Deletion completed, but refreshing the list failed: ${caught instanceof Error ? caught.message : 'please retry refreshing the list.'}`);
        else { setUnconfirmed(true); setError(`The deletion request was not confirmed. Some records may already have been deleted from active access. Refresh the preview to check what remains before continuing. ${caught instanceof Error ? caught.message : ''}`); }
      }
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  const trapFocus = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); if (!saving.current) onClose(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...(formRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])];
    if (!nodes.length) { event.preventDefault(); formRef.current?.focus(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === formRef.current)) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && (document.activeElement === last || document.activeElement === formRef.current)) { event.preventDefault(); first.focus(); }
  };
  const disabled = loading || busy || unconfirmed || Boolean(validateDeletionConfirmation(preview, confirmation));
  return <div className="modal-backdrop"><form ref={formRef} className="admin-dialog workspace-create-dialog admin-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-delete-heading" aria-describedby="admin-delete-intro" aria-busy={busy || loading} tabIndex={-1} onKeyDown={trapFocus} onSubmit={submit} noValidate>
    <div className="admin-dialog-header"><div><h2 id="admin-delete-heading"><Trash2 size={23} aria-hidden="true"/> Delete {scope === 'all' ? 'all ' : 'selected '}{deletionLabel(resource)}</h2><p id="admin-delete-intro" className="workspace-create-intro">Review the exact records and protections before confirming deletion.</p></div><button type="button" disabled={busy} aria-label="Close deletion preview" onClick={() => { if (!saving.current) onClose(); }}><X size={20}/></button></div>
    <div className="workspace-create-body">
      <p className="workspace-create-note admin-delete-retention"><Archive size={20} aria-hidden="true"/> This deletes records from active access by archiving them. Existing business data, invoices, wallet balances and transaction history are retained. This is not a permanent data wipe.</p>
      {resource === 'workspaces' ? <p className="workspace-create-help">Deleting a business disables workspace access and sending. Its user accounts are not deleted. Owners are not automatically given a replacement business after deletion.</p> : <p className="workspace-create-help">Deleting an account removes sign-in access, workspace memberships and active assignments. An owner of an undeleted business is protected: transfer ownership or delete that business first. Your signed-in account and the last available superadmin are protected.</p>}
      {scope === 'all' && <p className="admin-delete-all-warning">This applies to ALL {deletionLabel(resource)} across all pages, not only the current search or filter. The preview is a fixed snapshot; records created afterward are not included.</p>}
      {loading ? <div className="workspace-create-loading" role="status"><RefreshCw size={22} aria-hidden="true"/> Loading deletion preview...</div> : result ? <><p className="workspace-create-note" role="status"><Check size={20} aria-hidden="true"/> {deletionResultSummary(result)}</p>{result.protected.length > 0 && <div className="admin-delete-list"><h3>Protected during deletion</h3>{result.protected.map(item => <div key={item.id}><b>{item.name || item.id}</b>{item.email && <small>{item.email}</small>}<p>{item.reason}</p></div>)}</div>}</> : preview ? <>
        <div className="admin-delete-counts"><span><b>{preview.targets.length}</b> eligible for deletion</span><span><b>{preview.protected.length}</b> protected</span><span><b>{preview.matchedCount}</b> matched</span></div>
        <div className="admin-delete-list"><h3>Eligible records</h3>{preview.targets.length ? preview.targets.map(item => <div key={item.id}><b>{item.name || item.id}</b>{item.email && <small>{item.email}</small>}<small>{item.id}</small></div>) : <p>No eligible records. Protected records will not be deleted.</p>}</div>
        {preview.protected.length > 0 && <div className="admin-delete-list admin-delete-protected"><h3><ShieldCheck size={20} aria-hidden="true"/> Protected records</h3>{preview.protected.map(item => <div key={item.id}><b>{item.name || item.id}</b>{item.email && <small>{item.email}</small>}<p>{item.reason}</p></div>)}</div>}
        <p className="workspace-create-help">This preview is temporary. Refresh it if it expires. The server checks protections again when deletion is confirmed.</p>
        <label className="admin-field"><span>Type <strong>{preview.confirmation}</strong> exactly to confirm</span><input id="admin-delete-confirmation" value={confirmation} disabled={busy || unconfirmed || !preview.targets.length} autoComplete="off" spellCheck={false} onChange={event => { setConfirmation(event.target.value); setError(''); }}/></label>
      </> : null}
      {error && <p className="admin-error" role="alert">{error}</p>}
    </div>
    <div className="admin-dialog-actions"><button type="button" disabled={busy} onClick={() => { if (!saving.current) onClose(); }}>{result ? 'Close' : 'Cancel'}</button><div className="workspace-create-navigation">{!result && <button type="button" disabled={loading || busy} onClick={loadPreview}><RefreshCw size={16} aria-hidden="true"/> {preview || unconfirmed ? 'Refresh preview' : 'Retry preview'}</button>}{result ? <button type="submit" className="outline-reference" disabled={busy}>{busy ? 'Refreshing...' : 'Refresh list'}</button> : <button type="submit" className="admin-delete-confirm" disabled={disabled}>{busy ? 'Deleting...' : `Delete ${preview?.targets.length || 0} ${resource === 'workspaces' ? 'businesses' : 'accounts'}`}</button>}</div></div>
  </form></div>;
}
