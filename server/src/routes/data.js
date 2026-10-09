import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireWorkspace } from '../middleware/workspace.js';
import { AdRecord, AnalyticsDashboard, Automation, CallLog, Campaign, Contact, Conversation, Message, MessageTemplate, ReportRequest, Segment } from '../models/Domain.js';

import { averageResponseTime, csv, messageMetrics } from '../services/metrics.js';
import conversationRouter from './conversations.js';
import { createWithCapacity } from '../services/capacity.js';
import { visibleWalletCharges } from '../services/walletReceipts.js';
import { recordScope, safeContactInput, isAgent, conversationScope, membershipCanClaim } from '../services/businessPolicy.js';
import { BusinessTag, BusinessTeam, WhatsAppNumber } from '../models/Business.js';
import User from '../models/User.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function crud(path, Model, populate = '') {
  router.get(path, async (req, res, next) => {
    try {
      let query = Model.find(await recordScope(req, path.slice(1))).sort({ updatedAt: -1 }).limit(200);
      if (populate) query = query.populate(populate, 'name email');
      const items = await query.lean();
      if (Model === Campaign && items.length) {
        const totals = await Message.aggregate([
          { $match: { workspace: req.workspace._id, campaign: { $in: items.map(item => item._id) }, direction: 'outbound' } },
          { $group: { _id: '$campaign', sent: { $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] } }, delivered: { $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] } }, read: { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } }, accepted: { $sum: { $cond: [{ $ifNull: ['$providerMessageId', false] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } } } },
        ]);
        const byId = new Map(totals.map(total => [String(total._id), total]));
        items.forEach(item => { const { _id, ...counts } = byId.get(String(item._id)) || { sent: 0, delivered: 0, read: 0, accepted: 0, failed: 0 }; Object.assign(item, counts); });
      }
      res.json({ items });
    } catch (error) { next(error); }
  });
  router.post(path, requireRole('owner', 'admin', 'agent'), async (req, res, next) => { try { if ([Campaign,Automation].includes(Model)) return res.status(409).json({message:'Use the validated business campaign or journey editor.'}); const payload = { ...(Model === Contact ? safeContactInput(req.body, req) : req.body), workspace: req.workspace._id }; if (Model === Contact && isAgent(req) && !payload.owner) payload.owner = req.user._id; if (Model === CallLog && isAgent(req)) payload.assignedTo = req.user._id; await validateReferences(req, payload); const stateError = providerStateError(Model, payload); if (stateError) return res.status(409).json({ message: stateError }); if (Model.schema.path('createdBy')) payload.createdBy = req.user._id; if (Model.schema.path('requestedBy')) payload.requestedBy = req.user._id; const item = await createWithCapacity(req, path.slice(1), Model, payload); res.status(201).json({ item, walletCharges: visibleWalletCharges(req) }); } catch (error) { next(error); } });
  router.patch(`${path}/:id`, requireRole('owner', 'admin', 'agent'), async (req, res, next) => { try { if ([Campaign,Automation].includes(Model)) return res.status(409).json({message:'Use the validated business campaign or journey editor.'}); const updates = Model === Contact ? safeContactInput(req.body, req) : { ...req.body }; if (Model === MessageTemplate && ['name','body','components','language','category','samples'].some(key=>updates[key]!==undefined)) updates.status = 'Draft'; if (Model === CallLog && isAgent(req)) for (const key of Object.keys(updates)) if (!['callbackPending','tag','durationSeconds'].includes(key)) delete updates[key]; for (const key of ['workspace', '_id', 'createdBy', 'requestedBy', 'providerTemplateId', 'providerPayload', 'approvalSyncedAt', 'dispatchKey', 'runs', 'versions']) delete updates[key]; await validateReferences(req, updates); const stateError = providerStateError(Model, updates); if (stateError) return res.status(409).json({ message: stateError }); const item = await Model.findOneAndUpdate({ ...(await recordScope(req, path.slice(1), { write: true })), _id: req.params.id }, { $set: updates }, { new: true, runValidators: true }); if (!item) return res.status(404).json({ message: 'Record not found.' }); res.json({ item }); } catch (error) { next(error); } });
  router.delete(`${path}/:id`, requireRole('owner', 'admin'), async (req, res, next) => { try { if (Model === Contact && req.body?.confirm !== true) return res.status(400).json({message:'Confirm permanent contact deletion.'}); const item = await Model.findOneAndDelete({ ...(await recordScope(req, path.slice(1), { write: true })), _id: req.params.id }); if (!item) return res.status(404).json({ message: 'Record not found.' }); res.status(204).end(); } catch (error) { next(error); } });
}

async function validateReferences(req, payload) {
  if(payload.owner&&!await User.exists({_id:payload.owner,isActive:true,deletedAt:null}))throw Object.assign(new Error('Choose an active contact owner.'),{status:400});
  if (payload.criteria?.contactIds && (!Array.isArray(payload.criteria.contactIds) || payload.criteria.contactIds.length > 5000 || await Contact.countDocuments({ workspace: req.workspace._id, _id: { $in: payload.criteria.contactIds } }) !== new Set(payload.criteria.contactIds).size)) throw Object.assign(new Error('Segment contacts must belong to this business.'), { status: 400 });
  if (payload.criteria && (typeof payload.criteria !== 'object' || Array.isArray(payload.criteria) || Object.keys(payload.criteria).some(key=>!['tags','contactIds'].includes(key)))) throw Object.assign(new Error('Use contact IDs or tag criteria for segments.'), { status: 400 });
  for (const [field, Model] of [['number', WhatsAppNumber], ['team', BusinessTeam], ['template', MessageTemplate], ['segment', Segment]]) if (payload[field] && !await Model.exists({ _id: payload[field], workspace: req.workspace._id })) throw Object.assign(new Error('Choose '+field+' from this business.'), { status: 400 });
  if (payload.contactIds && (!Array.isArray(payload.contactIds) || payload.contactIds.length > 5000 || await Contact.countDocuments({ workspace: req.workspace._id, _id: { $in: payload.contactIds } }) !== new Set(payload.contactIds).size)) throw Object.assign(new Error('Choose contacts from this business.'), { status: 400 });
  if (payload.contact && !await Contact.exists({ _id: payload.contact, workspace: req.workspace._id })) throw Object.assign(new Error('Contact does not belong to this business.'), { status: 400 });
  if (payload.assignedTo && !req.workspace.members.some(member => String(member.user) === String(payload.assignedTo) && !member.disabled && ['owner', 'admin', 'agent', 'supervisor'].includes(member.role))) throw Object.assign(new Error('Choose an active business member.'), { status: 400 });
  if (isAgent(req) && payload.tags) {
    const tags = await BusinessTag.find({ workspace: req.workspace._id, archivedAt: null, name: { $in: payload.tags } }).lean();
    if (tags.length !== new Set(payload.tags).size) throw Object.assign(new Error('Agents may apply existing active tags only.'), { status: 400 });
  }
}

function providerStateError(Model, payload) {
  if (Model === MessageTemplate && Object.keys(payload).some(key => ['providerTemplateId', 'providerPayload', 'metaTemplateId', 'providerStatus', 'approvalSyncedAt', 'rejectionReason'].includes(key))) return 'Provider approval and credentials cannot be set through record editing.';
  if (Model === MessageTemplate && payload.status !== undefined && payload.status !== 'Draft') return 'Approval states come from the provider. Save a draft or synchronize provider status.';
  if (Model === Automation && Object.keys(payload).some(key => ['publication','enabled','version','versions','runs'].includes(key))) return 'Use the validated journey editor and publish action.';
  if (Model === Campaign && payload.status !== undefined && payload.status !== 'Draft') return 'Use the campaign preview, confirmed launch and control actions.';
  if (Model === Automation && payload.status === 'Active') return 'Connect the WhatsApp provider before activating automations.';
  if (Model === Campaign && ['Running', 'Completed'].includes(payload.status)) return 'Use the Smartping campaign send action to dispatch messages. Delivery totals come from provider events.';
  if (Model === MessageTemplate && ['Pending', 'Approved'].includes(payload.status)) return 'Connect the Meta provider before submitting templates for approval.';
  return '';
}

crud('/contacts', Contact);
crud('/calls', CallLog, 'contact assignedTo');
crud('/campaigns', Campaign);
crud('/templates', MessageTemplate, 'createdBy');
crud('/automations', Automation, 'createdBy');
crud('/dashboards', AnalyticsDashboard, 'createdBy');
router.get('/reports', async (req, res, next) => {
  try { res.json({ items: await ReportRequest.find({ workspace: req.workspace._id, ...(isAgent(req) ? { requestedBy: req.user._id } : {}) }).populate('requestedBy', 'name').sort({ createdAt: -1 }) }); } catch (error) { next(error); }
});
router.post('/reports', requireRole('owner', 'admin', 'agent'), async (req, res, next) => {
  try {
    const { type, dateRange } = req.body;
    if (!['Agent activity', 'Account summary'].includes(type) || !['Last 7 days', 'Last 30 days'].includes(dateRange)) return res.status(400).json({ message: 'Choose a report type and date range.' });
    const start = new Date(Date.now() - (dateRange === 'Last 7 days' ? 7 : 30) * 86400000);
    const ids = isAgent(req) ? await Conversation.distinct('_id', conversationScope(req)) : null;
    const filter = { workspace: req.workspace._id, createdAt: { $gte: start }, ...(ids ? { conversation: { $in: ids } } : {}) };
    let rows;
    if (type === 'Agent activity') {
      const messages = await Message.find({ ...filter, direction: 'outbound' }).populate('sender', 'name email').lean();
      rows = [['Agent', 'Email', 'Message date', 'Status', 'Conversation'], ...messages.map(m => [m.sender?.name || 'Unassigned', m.sender?.email || '', m.createdAt.toISOString(), m.status, m.conversation])];
    } else {
      const [contacts, conversations, messages, campaigns] = await Promise.all([Contact.countDocuments({ ...(await recordScope(req,'contacts')), createdAt: { $gte: start } }), Conversation.countDocuments({ ...conversationScope(req), createdAt: { $gte: start } }), Message.find(filter).lean(), req.permissions.includes('campaigns.read') || req.user.role === 'superadmin' ? Campaign.countDocuments({ workspace:req.workspace._id, createdAt:{ $gte:start } }) : 0]);
      rows = [['Metric', 'Value'], ['New contacts', contacts], ['New conversations', conversations], ['Campaigns created', campaigns], ...Object.entries(messageMetrics(messages))];
    }
    const item = await createWithCapacity(req, 'reports', ReportRequest, { workspace: req.workspace._id, type, dateRange, status: 'Complete', requestedBy: req.user._id, fileName: type.toLowerCase().replaceAll(' ', '-') + '-' + Date.now() + '.csv', content: csv(rows) });
    res.status(201).json({ item: { _id: item._id, fileName: item.fileName, status: item.status }, walletCharges: visibleWalletCharges(req) });
  } catch (error) { next(error); }
});
router.get('/reports/:id/download', async (req, res, next) => {
  try {
    const report = await ReportRequest.findOne({ _id: req.params.id, workspace: req.workspace._id, ...(isAgent(req) ? { requestedBy: req.user._id } : {}) }).select('+content');
    if (!report?.content) return res.status(404).json({ message: 'Report file is unavailable. Generate a new report.' });
    res.json({ fileName: report.fileName, content: report.content });
  } catch (error) { next(error); }
});
crud('/segments', Segment, 'createdBy');
crud('/ads', AdRecord);

router.get('/overview', async (req, res, next) => {
  try {
    const workspace = req.workspace._id;
    const canRead = feature => req.user.role === 'superadmin' || req.enabledFeatures.includes(feature) && req.permissions.includes(`${feature}.read`);
    const chatScope = conversationScope(req);
    const contactScope = canRead('contacts') ? await recordScope(req, 'contacts') : { workspace, _id: { $in: [] } };
    const count = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - count + 1);
    const [contacts, conversations, messages, templates, recentConversations] = await Promise.all([
      canRead('contacts') ? Contact.countDocuments(contactScope) : 0,
      canRead('conversations') ? Conversation.countDocuments(chatScope) : 0,
      canRead('analytics') && canRead('conversations') ? Message.find({ workspace, createdAt: { $gte: start }, ...(isAgent(req) ? { conversation: { $in: await Conversation.distinct('_id', chatScope) } } : {}) }).select('direction status createdAt').lean() : [],
      canRead('templates') ? MessageTemplate.find(await recordScope(req,'templates')).sort({ updatedAt: -1 }).limit(3).lean() : [],
      canRead('contacts') && canRead('conversations') ? Conversation.find(chatScope).populate({path:'contact',match:{workspace},select:'name phone'}).sort({ lastMessageAt: -1 }).limit(5).lean() : [],
    ]);
    const { sent, delivered, read } = messageMetrics(messages);
    const days = Array.from({ length: count }, (_, offset) => {
      const date = new Date(start); date.setDate(date.getDate() + offset);
      const end = new Date(date); end.setDate(end.getDate() + 1);
      return { day: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), ...messageMetrics(messages.filter(item => item.createdAt >= date && item.createdAt < end)) };
    });
    let workload = null;
    if (isAgent(req)) {
      const assigned = { ...conversationScope(req,{write:true}), assignedTo: req.user._id };
      const [open, awaitingReply, closed, unassigned, callbacks, queue, unassignedQueue] = await Promise.all([
        canRead('conversations') ? Conversation.countDocuments({ ...assigned, status: 'open' }) : 0,
        canRead('conversations') ? Conversation.countDocuments({ ...assigned, status: 'awaiting_reply' }) : 0,
        canRead('conversations') ? Conversation.countDocuments({ ...assigned, status: 'closed' }) : 0,
        canRead('conversations') && membershipCanClaim(req) ? Conversation.countDocuments({ ...conversationScope(req,{unassigned:true}), assignedTo: null, status: { $ne: 'closed' } }) : 0,
        canRead('calls') ? CallLog.countDocuments({ ...assigned, callbackPending: true }) : 0,
        canRead('contacts') && canRead('conversations') ? Conversation.find({ ...assigned, status: { $ne: 'closed' } }).populate('contact', 'name phone').sort({ lastMessageAt: -1 }).limit(25).lean() : [],
        canRead('contacts') && canRead('conversations') && membershipCanClaim(req) ? Conversation.find({ ...conversationScope(req,{unassigned:true}), assignedTo: null, status: { $ne: 'closed' } }).populate({path:'contact',match:{workspace},select:'name phone'}).sort({ lastMessageAt: -1 }).limit(4).lean() : [],
      ]);
      workload = { open, awaitingReply, closed, unassigned, callbacks, queue, unassignedQueue };
    }
    res.json({ metrics: { contacts, conversations, sent, delivered, read }, chart: days, recentConversations, templates, workload });
  } catch (error) { next(error); }
});

router.get('/analytics', async (req, res, next) => {
  try {
    const workspace = req.workspace._id;
    const [pendingReplies, conversations, messages] = await Promise.all([
      Conversation.countDocuments({ workspace, status: 'awaiting_reply', lastMessageAt: { $gte: new Date(Date.now() - 86400000) } }),
      Conversation.countDocuments({ workspace, status: { $ne: 'closed' } }),
      Message.find({ workspace }).select('conversation direction status createdAt').lean(),
    ]);
    res.json({ pendingReplies, averageResponseMs: averageResponseTime(messages), conversations, inbound: messages.filter(m => m.direction === 'inbound').length, outbound: messageMetrics(messages).sent });
  } catch (error) { next(error); }
});

// Every conversation operation uses the scoped router, including legacy API mounts.
router.use('/conversations', conversationRouter);

export default router;
