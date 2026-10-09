import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireWorkspace } from '../middleware/workspace.js';
import { Campaign, Contact, Message, MessageTemplate } from '../models/Domain.js';
import { assertConfigured, configuration, deliveryUpdate, SmartpingError, validateTemplate, verifyCallback } from '../services/smartping.js';
import { checkSmartpingAuthentication, conversationForContact, sendTemplate } from '../services/whatsapp.js';
import { checkSendingPolicy, platformSettings } from '../services/platform.js';
import { settleMessageCharge } from '../services/wallet.js';
import { visibleWalletCharges } from '../services/walletReceipts.js';

const router = Router();

// Smartping documents no signature header. Use a per-message HMAC in callbackUrl.
router.post('/events/:workspaceId/:messageId', async (req, res, next) => {
  try {
    const { workspaceId, messageId } = req.params;
    if (!mongoose.isValidObjectId(workspaceId) || !mongoose.isValidObjectId(messageId) || !verifyCallback(workspaceId, messageId, req.query.token, process.env.SMARTPING_WEBHOOK_SECRET)) return res.status(401).json({ message: 'Invalid callback authentication.' });
    const event = deliveryUpdate(req.body);
    const item = await Message.findOne({ _id: messageId, workspace: workspaceId, provider: 'smartping' });
    if (!item) return res.status(404).json({ message: 'Message not found.' });
    if (item.providerMessageId && item.providerMessageId !== event.providerMessageId) return res.status(409).json({ message: 'Provider message ID mismatch.' });
    const allowed = { sent: ['queued', 'unknown', 'sent'], delivered: ['queued', 'unknown', 'sent', 'delivered'], read: ['queued', 'unknown', 'sent', 'delivered', 'read'], failed: ['queued', 'unknown', 'sent', 'failed'] }[event.status];
    const update = { status: event.status, providerMessageId: event.providerMessageId, providerEventAt: event.timestamp };
    if (event.error) update.error = event.error;
    await Message.updateOne({ _id: item._id, workspace: workspaceId, status: { $in: allowed }, $and: [
      { $or: [{ providerEventAt: { $exists: false } }, { providerEventAt: { $lte: event.timestamp } }] },
      { $or: [{ providerMessageId: { $exists: false } }, { providerMessageId: event.providerMessageId }] },
    ] }, { $set: update, ...(!event.error ? { $unset: { error: '' } } : {}) });
    await settleMessageCharge(workspaceId, messageId);
    res.json({ received: true });
  } catch (error) { next(error); }
});

router.use(requireAuth, requireWorkspace);
router.get('/status', (req, res) => {
  if (['agent','supervisor'].includes(req.membership.role) && !req.permissions.includes('integrations.manage') && req.user.role !== 'superadmin') return res.json({ provider: 'smartping', configured: String(req.workspace._id) === process.env.SMARTPING_WORKSPACE_ID && configuration().configured, missing: [], deliveryTracking: Boolean(configuration().deliveryTracking) });
  if (String(req.workspace._id) !== process.env.SMARTPING_WORKSPACE_ID) return res.json({ provider: 'smartping', configured: false, missing: ['Workspace has no Smartping account'], deliveryTracking: false });
  res.json({ ...configuration(), workspaceId: String(req.workspace._id) });
});
router.post('/check', requireRole('owner', 'admin'), async (req, res, next) => {
  try { res.json(await checkSmartpingAuthentication(req.workspace._id)); } catch (error) { next(error); }
});
router.post('/templates/:id/configure', requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const payload = validateTemplate(req.body.template);
    const item = await MessageTemplate.findOneAndUpdate({ _id: req.params.id, workspace: req.workspace._id }, { $set: { providerTemplateId: payload.templateId, providerPayload: payload } }, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ message: 'Template not found.' });
    res.json({ item });
  } catch (error) { next(error); }
});
router.post('/campaigns/:id/send', requireRole('owner', 'admin'), async (req, res, next) => {
  return res.status(409).json({ message: 'Campaigns now require an audience preview, final confirmation and background launch through /api/business/campaigns/:id/launch.' });
  /* Retained during migration for provider contract reference; unreachable.
  try {
    assertConfigured(req.workspace._id);
    await checkSendingPolicy(req.workspace._id);
    const settings = await platformSettings();
    if (!settings.broadcastsEnabled) throw new SmartpingError('Broadcast sending is paused by the platform administrator.', 403);
    const template = validateTemplate(req.body.template);
    const ids = req.body.contactIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > settings.maxBroadcastRecipients || ids.some(id => !mongoose.isValidObjectId(id)) || new Set(ids).size !== ids.length) throw new SmartpingError(`Select 1 to ${settings.maxBroadcastRecipients} distinct customers.`);
    const contacts = await Contact.find({ workspace: req.workspace._id, _id: { $in: ids }, subscribed: true });
    if (contacts.length !== ids.length) throw new SmartpingError('All recipients must belong to this workspace and have WhatsApp consent.');
    const key = req.body.idempotencyKey;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9._-]{8,100}$/.test(key)) throw new SmartpingError('A unique request key is required.');
    const campaign = await Campaign.findOneAndUpdate({ _id: req.params.id, workspace: req.workspace._id, dispatchKey: { $exists: false }, status: { $in: ['Draft', 'Scheduled', 'Paused'] } }, { $set: { status: 'Running', dispatchKey: key, templateName: template.templateId, templatePayload: template, contactIds: ids, audienceSize: ids.length } }, { new: true });
    if (!campaign) return res.status(409).json({ message: 'Campaign was already dispatched or is unavailable. Check its messages before sending again.' });
    const results = [];
    for (const contact of contacts) {
      try {
        const conversation = await conversationForContact(req.workspace._id, contact._id, req.user._id, req);
        const sent = await sendTemplate({ workspace: req.workspace._id, conversation, sender: req.user._id, template, metaData: { tag1: campaign.name, tag2: String(campaign._id) }, campaign: campaign._id, idempotencyKey: key + ':' + contact._id });
        (req.walletCharges ||= []).push(...sent.walletCharges);
        results.push({ contactId: contact._id, messageId: sent.item._id, status: sent.item.status, accepted: Boolean(sent.item.providerMessageId) });
      } catch (error) {
        results.push({ contactId: contact._id, accepted: false, uncertain: Boolean(error.uncertain), message: error.message });
        // Stop on authentication, timeout, or rejection; do not repeat potentially accepted requests.
        break;
      }
    }
    const accepted = results.filter(result => result.accepted).length;
    if (accepted) await MessageTemplate.updateOne({ workspace: req.workspace._id, providerTemplateId: template.templateId }, { $set: { lastUsedAt: new Date() } });
    campaign.status = accepted === contacts.length ? 'Completed' : 'Paused';
    await campaign.save();
    res.status(202).json({ campaign, results, accepted, total: contacts.length, walletCharges: visibleWalletCharges(req), message: accepted + ' of ' + contacts.length + ' messages accepted by Smartping. Delivery is tracked separately.' });
  } catch (error) { next(error); } */
});

export default router;
