import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { AdRecord, AnalyticsDashboard, Automation, CallLog, Campaign, Contact, Conversation, Message, MessageTemplate, ReportRequest, Segment } from '../models/Domain.js';
import { AdminAudit, FEATURES, PlatformInvoice, PlatformPlan, PlatformSettings } from '../models/Platform.js';
import { requireAuth } from '../middleware/auth.js';
import { requireSuperadmin } from '../middleware/superadmin.js';
import { platformSettings, workspaceFeatures } from '../services/platform.js';
import { configuration, SmartpingError, validateTemplate } from '../services/smartping.js';
import operations from './superadminOperations.js';
import { validateCapacities } from '../services/accessControl.js';
import { passwordPolicyError, validatePlatformConfig } from '../services/platformConfig.js';
import { validateSubscriptionExpiry, validateWorkspaceBusinessFields } from '../services/workspaceConfig.js';
import { provisionSuperadminWorkspace, workspaceConflict } from '../services/superadminWorkspace.js';
import { createSuperadminAccount } from '../services/superadminUser.js';
import adminDeletion from './adminDeletion.js';
import { adminWallet } from './wallet.js';
import { generateInvoicePdf, invoicePdfFileName } from '../services/invoicePdf.js';
import { managementScope, mergeManagedMembers, protectBusinessAdmins } from '../services/superadminManagement.js';
import { effectiveWorkspacePlan, validateCustomPlan } from '../services/workspacePlan.js';
import { CAPACITY_KEYS, CAPABILITIES, workspaceRolePolicy } from '../services/accessControl.js';
import { walletConfig } from '../services/wallet.js';
import { ACTIVITY_UNITS, workspacePricing } from '../services/walletConfig.js';

const router = Router();
router.use(requireAuth, requireSuperadmin);
router.use('/deletions', adminDeletion);
router.use((req, _res, next) => { req.body ||= {}; next(); });
router.use(adminWallet);
const route = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const fail = (message, status = 400) => { throw new SmartpingError(message, status); };
const id = value => { if (!mongoose.isValidObjectId(value)) fail('Invalid record ID.'); return value; };
const select = (body, fields) => Object.fromEntries(fields.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
const expression = value => String(value || '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const resources = {
  contacts: [Contact, ['name', 'phone', 'email', 'tags', 'subscribed', 'source']],
  conversations: [Conversation, ['contact', 'assignedTo', 'channel', 'status', 'stage']],
  messages: [Message, []],
  calls: [CallLog, ['contact', 'assignedTo', 'name', 'ownerName', 'type', 'callbackPending', 'tag', 'occurredAt', 'durationSeconds']],
  campaigns: [Campaign, ['name', 'category', 'templateName', 'scheduledAt']],
  templates: [MessageTemplate, ['name', 'category', 'language', 'body', 'providerTemplateId', 'providerPayload']],
  automations: [Automation, ['name', 'trigger', 'message']],
  dashboards: [AnalyticsDashboard, ['name', 'widgets']],
  reports: [ReportRequest, []],
  segments: [Segment, ['name', 'dynamic', 'criteria']],
  ads: [AdRecord, ['name', 'source', 'status', 'impressions', 'clicks', 'chats', 'costPerChat', 'conversionApi', 'spend']],
};

router.get('/overview', route(async (_req, res) => {
  const [users, activeUsers, workspaces, suspendedWorkspaces, invoices, recentAudit, settings, ...counts] = await Promise.all([
    User.countDocuments({ deletedAt: null }), User.countDocuments({ isActive: true, deletedAt: null }), Workspace.countDocuments({ deletedAt: null }), Workspace.countDocuments({ isActive: false, deletedAt: null }),
    PlatformInvoice.aggregate([{ $group: { _id: { currency: '$currency', status: '$status' }, amount: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    AdminAudit.find().populate('actor', 'name email').sort({ createdAt: -1 }).limit(8).lean(), platformSettings(),
    ...Object.values(resources).map(([Model]) => Model.countDocuments()),
  ]);
  res.json({ users, activeUsers, workspaces, suspendedWorkspaces, resources: Object.fromEntries(Object.keys(resources).map((key, index) => [key, counts[index]])), invoices, recentAudit, settings, health: { database: mongoose.connection.readyState === 1 ? 'Connected' : 'Unavailable', uptimeSeconds: Math.round(process.uptime()), provider: configuration() } });
}));
router.get('/catalogue', (_req, res) => res.json({ features: FEATURES, capabilities: CAPABILITIES, rolePolicy: workspaceRolePolicy({}), resources: Object.fromEntries(Object.entries(resources).map(([key, [, fields]]) => [key, { fields, readOnly: fields.length === 0 }])) }));

router.get('/users', route(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = { deletedAt: null, ...(req.query.q ? { $or: [{ name: new RegExp(expression(req.query.q), 'i') }, { email: new RegExp(expression(req.query.q), 'i') }] } : {}) };
  const [items, total] = await Promise.all([User.find(filter).select('-sessionVersion').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(), User.countDocuments(filter)]);
  res.json({ items, total, page });
}));
router.post('/users', route(async (req, res) => {
  res.status(201).json(await createSuperadminAccount(req.body));
}));
router.patch('/users/:id', route(async (req, res) => {
  id(req.params.id);
  const updates = select(req.body, ['name', 'email', 'company', 'role', 'isActive']);
  if (updates.role !== undefined && !['superadmin', 'owner', 'admin', 'agent', 'supervisor'].includes(updates.role)) fail('Invalid account role.');
  if (updates.isActive !== undefined && typeof updates.isActive !== 'boolean') fail('Account status must be true or false.');
  if (updates.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) fail('Enter a valid email address.');
  if (String(req.user._id) === req.params.id && (updates.isActive === false || (updates.role && updates.role !== 'superadmin'))) fail('You cannot suspend or remove your own superadmin access.', 409);
  const session = await mongoose.startSession();
  let item;
  try {
    await session.withTransaction(async () => {
      // Serialize privilege changes to prevent two admins disabling each other concurrently.
      await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $inc: { controlVersion: 1 } }, { upsert: true, session });
      await managementScope(req, session);
      item = await User.findById(req.params.id).session(session);
      if (!item || item.deletedAt) fail('User not found.', 404);
      if (item.role === 'superadmin' && item.isActive && (updates.isActive === false || (updates.role && updates.role !== 'superadmin')) && await User.countDocuments({ role: 'superadmin', isActive: true, deletedAt: null }).session(session) <= 1) fail('At least one active superadmin is required.', 409);
      if (updates.isActive === false && item.isActive) await protectBusinessAdmins(item._id, session);
      if ((updates.role && updates.role !== item.role) || updates.isActive === false) item.sessionVersion = (item.sessionVersion || 0) + 1;
      Object.assign(item, updates); await item.save({ session });
      if (updates.isActive === false) await Conversation.updateMany({ assignedTo: item._id, status: { $ne: 'closed' } }, { $set: { assignedTo: null }, $inc: { version: 1 } }, { session });
    });
  } finally { await session.endSession(); }
  res.json({ item: item.toSafeObject() });
}));
router.post('/users/:id/reset-password', route(async (req, res) => {
  id(req.params.id);
  const passwordError = passwordPolicyError(req.body.password, await platformSettings(), 10); if (passwordError) fail(passwordError);
  const session = await mongoose.startSession();
  try { await session.withTransaction(async () => {
    await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $inc: { controlVersion: 1 } }, { upsert: true, session });
    await managementScope(req, session);
    const item = await User.findById(req.params.id).session(session);
    if (!item || item.deletedAt) fail('User not found.', 404);
    item.password = req.body.password; item.sessionVersion = (item.sessionVersion || 0) + 1; await item.save({ session });
  }); } finally { await session.endSession(); }
  res.json({ message: 'Password updated. Existing sessions have been revoked.' });
}));

router.get('/workspaces', route(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = { deletedAt: null, ...(req.query.q ? { name: new RegExp(expression(req.query.q), 'i') } : {}) };
  const [items, total] = await Promise.all([Workspace.find(filter).select('+adminNotes').populate('owner members.user', 'name email isActive').populate('plan').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(), Workspace.countDocuments(filter)]);
  res.json({ items, total, page });
}));
router.post('/workspaces', route(async (req, res) => {
  res.status(201).json(await provisionSuperadminWorkspace(req.body));
}));
router.get('/workspaces/:id/manage', route(async (req, res) => {
  const item = await Workspace.findOne({ _id: id(req.params.id), deletedAt: null }).select('+adminNotes').populate('plan').lean();
  if (!item) fail('Workspace not found.', 404);
  const users = await User.find({ _id: { $in: item.members.map(member => member.user) }, deletedAt: null }).select('name email company role isActive lastLoginAt').lean();
  const settings = await platformSettings();
  res.set('Cache-Control', 'no-store').json({ workspace: item, users, passwordPolicy: { minLength: Math.max(10, settings.passwordMinLength || 10), requireUppercase: Boolean(settings.passwordRequireUppercase), requireNumber: Boolean(settings.passwordRequireNumber) } });
}));
router.patch('/workspaces/:id', route(async (req, res) => {
  const item = await Workspace.findById(id(req.params.id)).select('+adminNotes');
  if (!item || item.deletedAt) fail('Workspace not found.', 404);
  const updates = select(req.body, ['name', 'isActive', 'sendingEnabled', 'plan', 'subscriptionEndsAt', 'disabledFeatures', 'adminNotes', 'settings']);
  Object.assign(updates, validateWorkspaceBusinessFields(req.body));
  if (req.body.subscriptionEndsAt !== undefined) updates.subscriptionEndsAt = validateSubscriptionExpiry(req.body.subscriptionEndsAt);
  for (const key of ['isActive', 'sendingEnabled']) if (updates[key] !== undefined && typeof updates[key] !== 'boolean') fail('Invalid workspace status.');
  if (updates.disabledFeatures !== undefined && (!Array.isArray(updates.disabledFeatures) || updates.disabledFeatures.some(feature => !FEATURES.includes(feature)))) fail('Invalid feature selection.');
  if (updates.plan) { if (!await PlatformPlan.exists({ _id: id(updates.plan), isActive: true })) fail('Choose an active plan.'); }
  if (updates.settings) updates.settings = { ...(item.settings?.toObject ? item.settings.toObject() : item.settings || {}), ...select(updates.settings, ['timezone', 'supportEmail', 'businessDescription']) };
  if (updates.seatLimits) updates.seatLimits = { ...(item.seatLimits?.toObject ? item.seatLimits.toObject() : item.seatLimits || {}), ...updates.seatLimits };
  Object.assign(item, updates);
  try { await item.save(); } catch (error) { throw workspaceConflict(error); }
  res.json({ item, enabledFeatures: await workspaceFeatures(item) });
}));
router.get('/workspaces/:id/custom-plan', route(async (req, res) => {
  const item = await Workspace.findOne({ _id: id(req.params.id), deletedAt: null }).populate('plan').lean();
  if (!item) fail('Workspace not found.', 404);
  const defaults = await walletConfig();
  const pricing = workspacePricing(defaults, item);
  res.set('Cache-Control', 'no-store').json({ workspace: { _id: item._id, name: item.name }, basePlan: item.plan || null, customPlan: item.customPlan || null, effectivePlan: await effectiveWorkspacePlan(item), features: FEATURES, capacityKeys: CAPACITY_KEYS, overrides: item.limits || {}, seatLimits: item.seatLimits || {}, activityPricing: { currency: 'INR', mode: 'test', units: ACTIVITY_UNITS, defaultPricesPaise: defaults.prices, pricesPaise: pricing.prices, source: pricing.pricingSource } });
}));
router.put('/workspaces/:id/custom-plan', route(async (req, res) => {
  const customPlan = { ...validateCustomPlan(req.body), updatedBy: req.user._id, updatedAt: new Date() };
  const fields = Object.fromEntries(Object.entries(customPlan).map(([key, value]) => ['customPlan.' + key, value]));
  const item = await Workspace.findOneAndUpdate({ _id: id(req.params.id), deletedAt: null }, { $set: fields, $inc: { capacityVersion: 1 } }, { new: true, runValidators: true });
  if (!item) fail('Workspace not found.', 404);
  req.workspace = item;
  req.auditDetails = { planName: customPlan.name, monthlyPrice: customPlan.monthlyPrice, currency: customPlan.currency };
  res.json({ message: 'Custom plan applied to this business only.', item });
}));
router.post('/workspaces/:id/custom-plan/restore', route(async (req, res) => {
  if (req.body.confirm !== true) fail('Confirm removing this business custom plan.');
  const item = await Workspace.findOneAndUpdate({ _id: id(req.params.id), deletedAt: null }, { $unset: { customPlan: '' }, $inc: { capacityVersion: 1 } }, { new: true });
  if (!item) fail('Workspace not found.', 404);
  req.workspace = item;
  res.json({ message: 'Custom plan removed. This business uses its assigned standard plan again.', item });
}));
router.put('/workspaces/:id/members', route(async (req, res) => {
  const { owner, members } = req.body;
  id(owner);
  if (!Array.isArray(members) || members.length > 1000 || members.some(member => !member || typeof member !== 'object' || Array.isArray(member) || typeof member.user !== 'string' || !mongoose.isValidObjectId(member.user) || !['owner', 'admin', 'agent', 'supervisor'].includes(member.role) || member.disabled !== undefined && typeof member.disabled !== 'boolean')) fail('Provide valid members and workspace roles.');
  if (new Set(members.map(member => member.user)).size !== members.length) fail('A member can only appear once.');
  if (!members.some(member => member.user === owner && member.role === 'owner') || members.some(member => member.role === 'owner' && member.user !== owner)) fail('Exactly one workspace owner is required.');
  const session = await mongoose.startSession(); let item;
  try { await session.withTransaction(async () => {
  await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $inc: { controlVersion: 1 } }, { upsert: true, session });
  item = await Workspace.findById(id(req.params.id)).session(session);
  if (!item || item.deletedAt) fail('Workspace not found.', 404);
  await Workspace.updateOne({ _id: item._id }, { $inc: { capacityVersion: 1 } }, { session });
  const users = await User.find({ deletedAt: null, _id: { $in: members.map(member => member.user) } }).session(session);
  if (users.length !== members.length || !users.some(user => String(user._id) === owner && user.isActive)) fail('All members must exist and the owner must be active.');
  const replacement = mergeManagedMembers(item.members, members);
  if (replacement.find(member => member.user === owner)?.disabled) fail('The workspace owner must have active business access.', 409);
  const previousMembers = item.members.map(member => String(member.user));
  const revoked = item.members.filter(previous => !replacement.some(member => member.user === String(previous.user) && member.role === previous.role && member.disabled === Boolean(previous.disabled))).map(member => member.user);
  item.owner = owner; item.members = replacement;
  req.workspace = item;
  await item.save({ session });
  if (revoked.length) await User.updateMany({ _id: { $in: revoked } }, { $inc: { sessionVersion: 1 } }, { session });
  const inaccessible = [...revoked.filter(user => !replacement.some(member => member.user === String(user) && !member.disabled)), ...replacement.filter(member => member.disabled).map(member => member.user)];
  if (inaccessible.length) await Conversation.updateMany({ workspace: item._id, assignedTo: { $in: inaccessible }, status: { $ne: 'closed' } }, { $set: { assignedTo: null }, $inc: { version: 1 } }, { session });
  const removed = previousMembers.filter(user => !members.some(member => member.user === user));
  if (removed.length) await User.updateMany({ _id: { $in: removed }, defaultWorkspace: item._id }, { $unset: { defaultWorkspace: '' }, $set: { autoWorkspaceCreationBlocked: true } }, { session });
  for (const user of users) if (!user.defaultWorkspace) { user.defaultWorkspace = item._id; user.autoWorkspaceCreationBlocked = false; await user.save({ session }); }
  }); } finally { await session.endSession(); }
  res.json({ item });
}));

router.get('/plans', route(async (_req, res) => res.json({ items: await PlatformPlan.find().sort({ createdAt: -1 }).lean() })));
router.post('/plans', route(async (req, res) => {
  if (req.body.limits !== undefined && !validateCapacities(req.body.limits)) fail('Invalid plan capacity limits.');
  res.status(201).json({ item: await PlatformPlan.create(select(req.body, ['name', 'description', 'monthlyPrice', 'currency', 'features', 'isActive', 'limits'])) });
}));
router.patch('/plans/:id', route(async (req, res) => {
  if (req.body.limits !== undefined && !validateCapacities(req.body.limits)) fail('Invalid plan capacity limits.');
  const item = await PlatformPlan.findByIdAndUpdate(id(req.params.id), { $set: select(req.body, ['name', 'description', 'monthlyPrice', 'currency', 'features', 'isActive', 'limits']) }, { new: true, runValidators: true });
  if (!item) fail('Plan not found.', 404); res.json({ item });
}));
router.get('/invoices', route(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const [items, total] = await Promise.all([PlatformInvoice.find().populate('workspace', 'name').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(), PlatformInvoice.countDocuments()]);
  res.json({ items, total, page });
}));
router.get('/invoices/:id/download', route(async (req, res) => {
  const invoice = await PlatformInvoice.findById(id(req.params.id)).populate('workspace', 'name').lean();
  if (!invoice) fail('Invoice not found.', 404);
  // Finish rendering before sending headers, so errors remain normal JSON API errors.
  const pdf = await generateInvoicePdf(invoice, await platformSettings());
  req.auditRead = true;
  req.auditDetails = { invoiceId: String(invoice._id), format: 'pdf' };
  if (invoice.workspace?._id) req.workspace = { _id: invoice.workspace._id };
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${invoicePdfFileName(invoice)}"`, 'Cache-Control': 'private, no-store' });
  res.send(pdf);
}));
router.post('/invoices', route(async (req, res) => {
  if (!await Workspace.exists({ _id: id(req.body.workspace), deletedAt: null })) fail('Workspace not found.', 404);
  const item = await PlatformInvoice.create({ ...select(req.body, ['workspace', 'description', 'amount', 'currency', 'dueAt']), invoiceNumber: 'WABA-' + new mongoose.Types.ObjectId().toString().toUpperCase(), createdBy: req.user._id });
  res.status(201).json({ item });
}));
router.patch('/invoices/:id', route(async (req, res) => {
  const item = await PlatformInvoice.findById(id(req.params.id)); if (!item) fail('Invoice not found.', 404);
  if (!['Draft', 'Issued', 'Paid', 'Void'].includes(req.body.status)) fail('Choose a valid invoice status.');
  if (item.status === 'Void') fail('A void invoice is immutable.', 409);
  if (item.status === 'Paid' && req.body.status !== 'Void') fail('Paid invoices may only be voided.', 409);
  if (req.body.status === 'Paid' && !String(req.body.paymentReference || '').trim()) fail('Enter the external payment reference.');
  item.status = req.body.status; item.paymentReference = req.body.paymentReference || item.paymentReference;
  if (item.status === 'Paid') item.paidAt = new Date(); await item.save(); res.json({ item });
}));
router.get('/settings', route(async (_req, res) => res.json({ settings: await platformSettings() })));
router.patch('/settings', route(async (req, res) => {
  const updates = validatePlatformConfig(req.body, FEATURES);
  if (updates.defaultPlan && !await PlatformPlan.exists({ _id: updates.defaultPlan, isActive: true })) fail('Choose an active default plan.');
  await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $set: updates }, { new: true, upsert: true, runValidators: true });
  res.json({ settings: await platformSettings() });
}));
router.get('/integrations', (_req, res) => res.json({ smartping: configuration(), workspaceId: process.env.SMARTPING_WORKSPACE_ID || '', credentialMode: process.env.SMARTPING_AUTH_TOKEN ? 'Server token' : 'Server login', callbackConfigured: Boolean(process.env.SMARTPING_CALLBACK_BASE_URL), supported: ['Approved template sends', 'Delivery callbacks'], unavailable: ['Inbound message API', 'Template approval API', 'Meta Ads sync', 'Automation scheduler'] }));
router.get('/audit', route(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = req.query.q ? { action: new RegExp(expression(req.query.q), 'i') } : {};
  const [items, total] = await Promise.all([AdminAudit.find(filter).populate('actor', 'name email').populate('workspace', 'name').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(), AdminAudit.countDocuments(filter)]);
  res.json({ items, total, page });
}));

router.use('/data/:resource', (req, res, next) => { if (!Object.hasOwn(resources, req.params.resource)) return res.status(404).json({ message: 'Unknown resource.' }); req.adminResource = resources[req.params.resource]; next(); });
async function dataWorkspace(req) {
  const workspaceId = id(req.query.workspace || req.body.workspace);
  if (!await Workspace.exists({ _id: workspaceId, deletedAt: null })) fail('Workspace not found.', 404);
  req.workspace = { _id: workspaceId };
  return workspaceId;
}
async function recordPayload(req, workspace) {
  const [, fields] = req.adminResource;
  if (!fields.length) fail('Provider messages and generated reports are read-only.');
  const payload = select(req.body, fields);
  if (payload.contact && !await Contact.exists({ _id: id(payload.contact), workspace })) fail('Contact must belong to this workspace.');
  if (payload.assignedTo && !await Workspace.exists({ _id: workspace, deletedAt: null, 'members.user': id(payload.assignedTo) })) fail('Assigned agent must be a workspace member.');
  if (payload.providerPayload) { payload.providerPayload = validateTemplate(payload.providerPayload); payload.providerTemplateId = payload.providerPayload.templateId; }
  if(req.adminResource[0]===MessageTemplate&&['name','category','language','body'].some(key=>payload[key]!==undefined))payload.status='Draft';
  return payload;
}
router.get('/data/:resource', route(async (req, res) => {
  const workspace = await dataWorkspace(req); const [Model] = req.adminResource;
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = { workspace };
  const [items, total] = await Promise.all([Model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(), Model.countDocuments(filter)]);
  res.json({ items, total, page });
}));
router.post('/data/:resource', route(async (req, res) => {
  const workspace = await dataWorkspace(req); const [Model] = req.adminResource;
  const payload = await recordPayload(req, workspace);
  const item = await Model.create({ ...payload, workspace, ...(Model.schema.path('createdBy') ? { createdBy: req.user._id } : {}) });
  res.status(201).json({ item });
}));
router.patch('/data/:resource/:id', route(async (req, res) => {
  const workspace = await dataWorkspace(req); const [Model] = req.adminResource;
  const item = await Model.findOneAndUpdate({ _id: id(req.params.id), workspace }, { $set: await recordPayload(req, workspace) }, { new: true, runValidators: true });
  if (!item) fail('Record not found.', 404); res.json({ item });
}));
router.delete('/data/:resource/:id', route(async (req, res) => {
  const workspace = await dataWorkspace(req); const [Model] = req.adminResource; const target = id(req.params.id);
  if (Model === Contact && await Conversation.exists({ workspace, contact: target })) fail('This contact has conversations. Remove related records first.', 409);
  if (Model === Conversation && await Message.exists({ workspace, conversation: target })) fail('This conversation contains messages. Remove related records first.', 409);
  if (Model === Campaign && await Message.exists({ workspace, campaign: target })) fail('This campaign contains message history. Keep it for delivery reporting.', 409);
  const item = await Model.findOneAndDelete({ _id: target, workspace }); if (!item) fail('Record not found.', 404);
  res.json({ message: 'Record removed.' });
}));
router.use(operations(resources));
export default router;
