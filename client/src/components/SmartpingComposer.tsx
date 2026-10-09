import { Permission, useWorkspaceAccess } from '../lib/WorkspaceAccessContext';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, type SmartpingStatus, type SmartpingTemplate } from '../lib/api';

type TemplateRecord = { _id: string; name: string; body: string; providerTemplateId?: string; providerPayload?: SmartpingTemplate };
type Recipient = { _id: string; name: string; phone: string; subscribed: boolean };
export default function SmartpingComposer({ conversationId, campaignId, templateRecordId, onClose, onNotice }: { conversationId?: string; campaignId?: string; templateRecordId?: string; onClose: () => void; onNotice: (message: string) => void }) {
  const access = useWorkspaceAccess();
  const configurationOnly = !conversationId && !campaignId;
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [payload, setPayload] = useState('{\n  "templateId": ""\n}');
  const [status, setStatus] = useState<SmartpingStatus | null>(null);
  const [contacts, setContacts] = useState<Recipient[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempted, setAttempted] = useState(false);
  const key = useRef(crypto.randomUUID());
  useEffect(() => {
    api.smartpingStatus().then(setStatus).catch(error => setError(error.message));
    if (access.can('templates.read')) api.list<TemplateRecord>('templates').then(result => {
      setTemplates(result.items);
      const record = result.items.find(item => item._id === templateRecordId);
      if (record) { setSelectedTemplate(record._id); setPayload(JSON.stringify(record.providerPayload || { templateId: record.providerTemplateId || record.name }, null, 2)); }
    }).catch(error => setError(error.message));
    if (campaignId && access.can('contacts.read')) api.list<Recipient>('contacts').then(result => setContacts(result.items.filter(contact => contact.subscribed))).catch(error => setError(error.message));
  }, [campaignId, templateRecordId]);
  const choose = (id: string) => {
    setSelectedTemplate(id);
    const record = templates.find(item => item._id === id);
    if (record) setPayload(JSON.stringify(record.providerPayload || { templateId: record.providerTemplateId || record.name }, null, 2));
  };
  const parsedTemplate = () => {
    let parsed;
    try { parsed = JSON.parse(payload); } catch { throw new Error('Template parameters must be valid JSON.'); }
    if (!parsed || typeof parsed.templateId !== 'string' || !parsed.templateId.trim()) throw new Error('Enter the approved Smartping template ID.');
    return parsed as SmartpingTemplate;
  };
  const save = async () => {
    if (!access.can('integrations.manage')) return;
    if (!selectedTemplate) return setError('Select a saved template first.');
    setBusy(true); setError('');
    try { await api.configureSmartpingTemplate(selectedTemplate, parsedTemplate()); window.dispatchEvent(new Event('waba:data-changed')); onNotice('Smartping template configuration saved.'); if (configurationOnly) onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Unable to save template.'); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!access.can(campaignId ? 'campaigns.send' : 'conversations.send')) return;
    setBusy(true); setError('');
    try {
      const template = parsedTemplate();
      if (campaignId && !selectedContacts.length) throw new Error('Choose at least one recipient.');
      // Keep this request key for the whole modal lifetime; retries cannot create duplicates.
      setAttempted(true);
      if (campaignId) { const result = await api.sendCampaign(campaignId, template, selectedContacts, key.current); onNotice(result.message); }
      else if (conversationId) {
        const result = await api.sendTemplate<{ status: string; providerMessageId?: string }>(conversationId, template, key.current);
        if (!result.item.providerMessageId) throw new Error('Request is ' + result.item.status + '. Check Smartping delivery reports before sending again.');
        onNotice('Smartping accepted the message. Delivery updates will appear in the conversation.');
      } else throw new Error('Select a conversation or campaign.');
      window.dispatchEvent(new Event('waba:data-changed')); onClose();
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to send message.'); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><section className="demo-modal smartping-composer" role="dialog" aria-modal="true" aria-label={configurationOnly ? 'Configure Smartping template' : 'Send WhatsApp template'}><div className="modal-head"><div><h2>{configurationOnly ? 'Configure Smartping template' : campaignId ? 'Send broadcast' : 'Send WhatsApp template'}</h2><p>Use a template already approved in your Smartping account.</p></div><button disabled={busy} onClick={onClose} aria-label="Close"><X size={20}/></button></div>
    {!status ? <p>Checking Smartping connection…</p> : !status.configured ? <p className="smartping-error">Smartping setup required: {status.missing.join(', ')}</p> : <p>Sender: {status.from} · {status.deliveryTracking ? 'Delivery tracking enabled' : 'Delivery tracking not configured'}</p>}
    <label>Saved template<select disabled={busy || attempted} value={selectedTemplate} onChange={event => choose(event.target.value)}><option value="">Enter template ID manually</option>{templates.map(item => <option value={item._id} key={item._id}>{item.name}</option>)}</select></label>
    <label>Smartping template parameters<textarea aria-label="Smartping template parameters" disabled={busy || attempted} rows={10} value={payload} onChange={event => setPayload(event.target.value)} spellCheck={false}/></label>
    <p>Use zero-based parameterValues and headerParameterValues. Optional fields: media (IMAGE, DOC, VIDEO), buttons, cards, templateUId. Values must match the approved template.</p>
    {campaignId && <fieldset disabled={busy || attempted}><legend>Recipients ({selectedContacts.length}/100)</legend><div className="smartping-recipients">{contacts.map(contact => <label key={contact._id}><input type="checkbox" checked={selectedContacts.includes(contact._id)} onChange={event => setSelectedContacts(current => event.target.checked ? current.length < 100 ? [...current,contact._id] : current : current.filter(id => id !== contact._id))}/>{contact.name} <small>{contact.phone}</small></label>)}</div>{contacts.length === 0 && <p>No customers with WhatsApp consent found.</p>}</fieldset>}
    {error && <p role="alert" className="smartping-error">{error}</p>}
    {attempted && error && <p>This attempt is locked to prevent duplicate sends. Check the conversation and Smartping report before creating another request.</p>}
    <div className="modal-actions"><Permission capability="integrations.manage"><button disabled={busy || attempted || !selectedTemplate} onClick={save}>Save template settings</button></Permission>{!configurationOnly && <button className="new-campaign" disabled={busy || attempted || !status?.configured || !access.can(campaignId ? 'campaigns.send' : 'conversations.send')} onClick={send}>{busy ? 'Processing...' : campaignId ? 'Send to selected customers' : 'Send template'}</button>}</div>
  </section></div>;
}
