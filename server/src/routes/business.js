import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { Contact, Conversation, Message, MessageTemplate, Segment } from '../models/Domain.js';
import { BusinessAudit, BusinessInvitation, BusinessNotification, BusinessTag, BusinessTeam, ContactNote, QuickReply, WhatsAppNumber } from '../models/Business.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { adminOnly, assertLastAdmin, audit, conversationScope, isAdmin, isAgent, objectId, recordScope, safeContactInput } from '../services/businessPolicy.js';
import { businessTransaction } from '../services/assignment.js';
import { parseContactCsv } from '../services/businessContacts.js';
import { SmartpingError, phoneNumber } from '../services/smartping.js';
import { activity } from '../services/businessPolicy.js';
import { membershipCapacityFilter, WORKSPACE_ROLES, workspaceRolePolicy, DEFAULT_PERMISSIONS, CAPABILITIES } from '../services/accessControl.js';
import { effectiveLimits, createWithCapacity } from '../services/capacity.js';
import { platformSettings } from '../services/platform.js';
import { passwordPolicyError } from '../services/platformConfig.js';
import { csv } from '../services/metrics.js';

import { assertActorPermission, assertCreationRole, validateBusinessRules, visibleMembers } from '../services/businessAccess.js';
const router = Router();
const hash = value => createHash('sha256').update(value).digest('hex');
const page = req => ({ offset: Math.max(0, Math.min(100000, Number(req.query.offset) || 0)), limit: Math.max(1, Math.min(100, Number(req.query.limit) || 25)) });
const escape = text => String(text || '').slice(0,100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One-use tokens are stored hashed and expire. The public endpoint never allows
// an existing account password to be replaced by a workspace invitation.
router.post('/invitation/accept', async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(req.body.token || '')) throw new SmartpingError('Invalid or expired invitation.', 400);
    const invitation = await BusinessInvitation.findOne({ tokenHash: hash(req.body.token), acceptedAt: null, expiresAt: { $gt: new Date() } }).select('+tokenHash');
    if (!invitation) throw new SmartpingError('Invalid or expired invitation.', 400);
    const settings = await platformSettings();
    const passwordError = passwordPolicyError(String(req.body.password || ''), settings);
    if (passwordError) throw new SmartpingError(passwordError);
    const inviter = await User.findOne({ _id: invitation.invitedBy, isActive: true, deletedAt: null });
    if (!inviter) throw new SmartpingError('The inviter no longer has active access.', 403);
    const reqForBusiness = { workspace: { _id: invitation.workspace }, user: inviter };
    await businessTransaction(reqForBusiness, async (workspace, session, actor) => {
      assertActorPermission(workspace, actor, inviter.role, 'team.manage');
      if (invitation.purpose === 'invite') assertCreationRole(workspace, invitation.role, inviter.role);
      const consumed = await BusinessInvitation.updateOne({ _id: invitation._id, acceptedAt: null, expiresAt: { $gt: new Date() } }, { $set: { acceptedAt: new Date() } }, { session });
      if (!consumed.modifiedCount) throw new SmartpingError('Invitation has already been used.', 409);
      let user = await User.findOne({ email: invitation.email }).select('+password').session(session);
      if (invitation.purpose === 'reset') {
        if (user?.role === 'superadmin' && inviter.role !== 'superadmin') throw new SmartpingError('Platform accounts can only be managed by Super Admin.', 403);
        const member = workspace.members.find(member => String(member.user) === String(user?._id));
        if (!user?.isActive || user.deletedAt || !member || member.disabled || !WORKSPACE_ROLES.includes(member.role) && member.role !== 'owner') throw new SmartpingError('Account access is unavailable.', 403);
        user.password = req.body.password; user.sessionVersion = (user.sessionVersion || 0) + 1; await user.save({ session });
      } else {
        if (user) throw new SmartpingError('This account already exists. Sign in and ask the Admin to add your registered account.', 409);
        [user] = await User.create([{ name: invitation.name || invitation.email.split('@')[0], email: invitation.email, password: req.body.password, role: invitation.role, defaultWorkspace: workspace._id }], { session });
        const limits = await effectiveLimits(workspace, session);
        const added = await Workspace.updateOne(membershipCapacityFilter(workspace._id, user._id, invitation.role, limits, false, inviter.role !== 'superadmin'), { $push: { members: { user: user._id, role: invitation.role } } }, { session });
        if (!added.modifiedCount) throw new SmartpingError('Business seat limit reached. Ask the Admin to resend after adding capacity.', 409);
      }
      await audit(reqForBusiness, invitation.purpose === 'reset' ? 'user.password-reset' : 'invitation.accept', 'User', user._id, 'success', session);
    });
    res.json({ message: 'Password saved. You can now sign in.' });
  } catch (error) { next(error); }
});
router.use(requireAuth, requireWorkspace);

router.get('/me', async (req, res, next) => {
  try {
    const chats = await Conversation.find({ workspace: req.workspace._id, assignedTo: req.user._id }).lean();
    const messages = await Message.find({ workspace: req.workspace._id, sender: req.user._id, direction: 'outbound' }).select('status createdAt').lean();
    res.json({ membership: { availability: req.membership.availability || 'offline', capacity: req.membership.capacity || 10, teams: req.membership.teams || [], visibility: req.membership.visibility || 'assigned' }, contactFields: req.workspace.settings?.contactFields || [], editableAgentFields: req.workspace.settings?.editableAgentFields || ['name','email','company'], performance: { active: chats.filter(chat => chat.status !== 'closed').length, resolved: chats.filter(chat => chat.status === 'closed').length, replies: messages.filter(message => ['sent','delivered','read'].includes(message.status)).length } });
  } catch (error) { next(error); }
});
router.get('/me/inbox-options', async (req,res,next)=>{
  try{
    const members=req.workspace.members.filter(member=>!member.disabled&&['owner','admin','agent','supervisor'].includes(member.role));
    const users=await User.find({_id:{$in:members.map(member=>member.user)},isActive:true,deletedAt:null}).select('name').lean();
    const teams=await BusinessTeam.find({workspace:req.workspace._id,archivedAt:null,...(isAgent(req)?{_id:{$in:req.membership.teams||[]}}:{})}).select('name').lean();
    const numbers=await WhatsAppNumber.find({workspace:req.workspace._id,...(isAgent(req)?{_id:{$in:req.membership.allowedNumbers||[]}}:{})}).select('phone').lean();
    const assignedIds=isAgent(req)?await Conversation.distinct('assignedTo',conversationScope(req)):null;
    res.json({users:assignedIds?users.filter(user=>assignedIds.some(id=>String(id)===String(user._id))||String(user._id)===String(req.user._id)):users,teams,numbers});
  }catch(error){next(error);}
});
router.patch('/me', async (req, res, next) => {
  try {
    if (!['available', 'away', 'offline'].includes(req.body.availability)) throw new SmartpingError('Choose an availability status.');
    await Workspace.updateOne({ _id: req.workspace._id, members: { $elemMatch: { user: req.user._id, disabled: { $ne: true }, role: { $in: ['owner','admin','agent','supervisor'] } } } }, { $set: { 'members.$.availability': req.body.availability } });
    res.json({ message: 'Availability updated.' });
  } catch (error) { next(error); }
});
router.get('/notifications', async (req, res, next) => {
  try { res.json({ items: await BusinessNotification.find({ workspace: req.workspace._id, user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean() }); } catch (error) { next(error); }
});
router.patch('/notifications/:id', async (req, res, next) => {
  try { await BusinessNotification.updateOne({ _id: objectId(req.params.id), workspace: req.workspace._id, user: req.user._id }, { $set: { readAt: new Date() } }); res.json({ message: 'Notification read.' }); } catch (error) { next(error); }
});
for (const [route, Model] of [['quick-replies', QuickReply], ['tags', BusinessTag], ['teams', BusinessTeam]]) {
  router.get('/' + route, async (req, res, next) => {
    try {

      const { offset, limit } = page(req);
      const filter = { workspace: req.workspace._id, ...(route === 'teams' && isAgent(req) && !req.permissions.includes('team.manage') ? { _id: { $in: req.membership.teams || [] } } : {}), ...(route !== 'quick-replies' ? { archivedAt: null } : {}), ...(route === 'quick-replies' && isAgent(req) ? { $or: [{ teams: { $size: 0 } }, { teams: { $in: req.membership.teams || [] } }] } : {}) };
      res.json({ items: await Model.find(filter).sort({ name: 1 }).skip(offset).limit(limit).lean(), total: await Model.countDocuments(filter) });
    } catch (error) { next(error); }
  });
  router.post('/' + route, adminOnly, async (req, res, next) => {
    try {
      const payload = contentInput(route, req.body);
      if (payload.teams?.length && await BusinessTeam.countDocuments({ workspace: req.workspace._id, _id: { $in: payload.teams }, archivedAt: null }) !== payload.teams.length) throw new SmartpingError('Choose teams from this business.');
      const item = await Model.create({ ...payload, workspace: req.workspace._id }); await audit(req, route + '.create', Model.modelName, item._id); res.status(201).json({ item });
    } catch (error) { next(error); }
  });
  router.patch('/' + route + '/:id', adminOnly, async (req, res, next) => {
    try {
      const payload = contentInput(route, req.body);
      if (payload.teams?.length && await BusinessTeam.countDocuments({ workspace: req.workspace._id, _id: { $in: payload.teams }, archivedAt: null }) !== payload.teams.length) throw new SmartpingError('Choose teams from this business.');
      if(route==='tags'){
        const item=await businessTransaction(req,async(workspace,session,actor)=>{
          assertActorPermission(workspace, actor, req.user.role, 'content.manage');
          const tag=await BusinessTag.findOne({_id:objectId(req.params.id),workspace:workspace._id,archivedAt:null}).session(session);
          if(!tag)throw new SmartpingError('Tag not found.',404);const oldName=tag.name;Object.assign(tag,payload);await tag.save({session});
          if(oldName!==tag.name){
            for(const Model of[Contact,Conversation])await Model.updateMany({workspace:workspace._id,tags:oldName},{$set:{'tags.$[value]':tag.name}},{session,arrayFilters:[{value:oldName}]});
            await Segment.updateMany({workspace:workspace._id,'criteria.tags':oldName},{$set:{'criteria.tags.$[value]':tag.name}},{session,arrayFilters:[{value:oldName}]});
          }
          await audit(req,'tags.update','BusinessTag',tag._id,'success',session);return tag;
        });return res.json({item});
      }
      const item = await Model.findOneAndUpdate({ _id: objectId(req.params.id), workspace: req.workspace._id }, { $set: payload }, { new: true, runValidators: true });
      if (!item) throw new SmartpingError('Record not found.', 404); await audit(req, route + '.update', Model.modelName, item._id); res.json({ item });
    } catch (error) { next(error); }
  });
  router.delete('/' + route + '/:id', adminOnly, async (req, res, next) => {
    try {
      if (req.body.confirm !== true) throw new SmartpingError('Confirm deletion or archival.');
      const filter = { _id: objectId(req.params.id), workspace: req.workspace._id };
      const item = route === 'quick-replies' ? await Model.findOneAndDelete(filter) : await Model.findOneAndUpdate(filter, { $set: { archivedAt: new Date() } });
      if (!item) throw new SmartpingError('Record not found.', 404); await audit(req, route + '.delete', Model.modelName, item._id); res.json({ message: route === 'quick-replies' ? 'Deleted.' : 'Archived.' });
    } catch (error) { next(error); }
  });
}
function contentInput(route, body) {
  const fields = route === 'quick-replies' ? ['name','shortcut','body','category','teams','variables'] : route === 'tags' ? ['name','color'] : ['name'];
  const payload=Object.fromEntries(Object.entries(body).filter(([key]) => fields.includes(key)));
  if(route==='quick-replies'&&payload.body!==undefined){
    if(typeof payload.body!=='string')throw new SmartpingError('Enter valid reply text.');
    payload.variables=[...new Set([...payload.body.matchAll(/\{\{\s*([^}]+)\s*\}\}/g)].map(match=>match[1].trim()))];
    if(payload.variables.some(value=>!['name','company','email'].includes(value)))throw new SmartpingError('Quick replies support name, company and email variables.');
  }
  return payload;
}

router.get('/users', adminOnly, async (req, res, next) => {
  try {
    const workspace = await Workspace.findById(req.workspace._id).populate('members.user', 'name email isActive deletedAt');
    const ids = new Set(visibleMembers(req).map(member => String(member.user)));
    res.json({ items: workspace.members.filter(member => ids.has(String(member.user?._id || member.user))), invitations: isAdmin(req) || req.permissions.includes('team.manage') ? await BusinessInvitation.find({ workspace: workspace._id, acceptedAt: null }).select('-tokenHash').sort({ createdAt: -1 }).lean() : [] });
  } catch (error) { next(error); }
});
// Accounts created here share the platform User and Workspace membership records.
// The random initial password is never returned; the user chooses a password
// through a hashed, expiring, single-use setup token.
router.post('/users', adminOnly, async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const role = req.body.role;
    if (!name || name.length > 80 || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !WORKSPACE_ROLES.includes(role)) throw new SmartpingError('Enter a name, valid email and business role.');
    let origin;
    try { origin = new URL(process.env.CLIENT_URL || 'http://localhost:5173'); } catch { throw new SmartpingError('Configure a valid CLIENT_URL.', 409); }
    if (origin.username || origin.password || !['http:','https:'].includes(origin.protocol) || process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new SmartpingError('Configure an HTTPS CLIENT_URL.', 409);
    const token = randomBytes(32).toString('hex');
    const result = await businessTransaction(req, async (workspace, session, actor) => {
      assertActorPermission(workspace, actor, req.user.role, 'team.manage');
      assertCreationRole(workspace, role, req.user.role);
      if (await User.exists({ email }).session(session)) throw new SmartpingError('This email is registered. Use Add existing account instead.', 409);
      const [user] = await User.create([{ name, email, role, company: workspace.name, defaultWorkspace: workspace._id, password: randomBytes(32).toString('hex') }], { session });
      const limits = await effectiveLimits(workspace, session);
      const added = await Workspace.updateOne(membershipCapacityFilter(workspace._id, user._id, role, limits, false, req.user.role !== 'superadmin'), { $push: { members: { user: user._id, role, visibility: role === 'supervisor' ? 'teams' : 'assigned' } } }, { session });
      if (!added.modifiedCount) throw new SmartpingError('Role creation access or seat capacity changed. Refresh and try again.', 409);
      const [invitation] = await BusinessInvitation.create([{ workspace: workspace._id, name, email, role, purpose: 'reset', tokenHash: hash(token), invitedBy: req.user._id, expiresAt: new Date(Date.now() + 48 * 3600000), deliveryStatus: 'manual-link' }], { session });
      await audit(req, 'user.create', 'User', user._id, 'success', session);
      return { item: user.toSafeObject(), expiresAt: invitation.expiresAt };
    });
    origin.searchParams.set('invitation', token);
    res.status(201).json({ ...result, link: origin.toString(), message: 'Account created and visible in Super Admin. Share the private password setup link; automatic email delivery is not configured.' });
  } catch (error) { next(error); }
});
router.get('/role-access', async (req, res) => {
  res.json({ policy: workspaceRolePolicy(req.workspace), version: req.workspace.rolePolicyVersion || 0, roles: WORKSPACE_ROLES, capabilities: CAPABILITIES, defaults: DEFAULT_PERMISSIONS, rules: req.workspace.permissionRules || [] });
});
router.put('/role-access', adminOnly, async (req, res, next) => {
  try {
    await businessTransaction(req, async (workspace, session, actor) => {
      assertActorPermission(workspace, actor, req.user.role, 'team.manage');
      if (req.body.expectedVersion !== (workspace.rolePolicyVersion || 0)) throw new SmartpingError('Role access changed. Reload before saving.', 409);
      if (!validateBusinessRules(workspace, req.body.rules)) throw new SmartpingError('Permissions must stay within the limits set by Super Admin.', 403);
      workspace.permissionRules = req.body.rules; workspace.rolePolicyVersion = (workspace.rolePolicyVersion || 0) + 1;
      await workspace.save({ session }); await audit(req, 'role.permissions-change', 'Workspace', workspace._id, 'success', session);
    });
    res.json({ message: 'Business role permissions saved.' });
  } catch (error) { next(error); }
});
router.patch('/users/:id', adminOnly, async (req, res, next) => {
  try {
    const id = objectId(req.params.id);
    if (req.body.role !== undefined && !WORKSPACE_ROLES.includes(req.body.role)) throw new SmartpingError('Choose Business Admin, Agent or Supervisor.');
    const updates = Object.fromEntries(Object.entries(req.body).filter(([key]) => ['role','disabled','teams','allowedNumbers','visibility','availability','capacity','canClaim'].includes(key)));
    if (updates.canClaim !== undefined && typeof updates.canClaim !== 'boolean') throw new SmartpingError('Claim permission must be a boolean.');
    if (updates.disabled !== undefined && typeof updates.disabled !== 'boolean') throw new SmartpingError('Disabled must be a boolean.');
    if (updates.visibility && !['assigned','teams'].includes(updates.visibility)) throw new SmartpingError('Invalid conversation visibility.');
    if (updates.availability && !['available','away','offline'].includes(updates.availability)) throw new SmartpingError('Invalid availability.');
    if (updates.capacity !== undefined && (!Number.isInteger(updates.capacity) || updates.capacity < 1 || updates.capacity > 500)) throw new SmartpingError('Capacity must be between 1 and 500.');
    const item = await businessTransaction(req, async (workspace, session, actor) => {
      assertActorPermission(workspace, actor, req.user.role, 'team.manage');
      const previousRole = workspace.members.find(member => String(member.user) === String(id))?.role;
      if (updates.role && updates.role !== previousRole) assertCreationRole(workspace, updates.role, req.user.role);
      const users = await User.find({ _id: { $in: workspace.members.map(member => member.user) }, isActive: true, deletedAt: null }).session(session).lean();
      const active = new Set(users.map(user => String(user._id)));
      const target = assertLastAdmin(workspace.members.map(member => ({ ...member.toObject(), disabled: member.disabled || !active.has(String(member.user)) })), id, updates);
      if (updates.role && updates.role !== target.role && workspace.seatLimits?.[updates.role] !== null && workspace.seatLimits?.[updates.role] !== undefined && workspace.members.filter(member => member.role === updates.role).length >= workspace.seatLimits[updates.role]) throw new SmartpingError('Role seat limit reached.', 409);
      for (const [key, Model] of [['teams', BusinessTeam], ['allowedNumbers', WhatsAppNumber]]) if (updates[key] !== undefined) {
        if (!Array.isArray(updates[key]) || updates[key].length > 100 || new Set(updates[key]).size !== updates[key].length || await Model.countDocuments({ workspace: workspace._id, _id: { $in: updates[key].map(objectId) }, ...(key === 'teams' ? { archivedAt: null } : {}) }).session(session) !== updates[key].length) throw new SmartpingError('Select records from this business.');
      }
      const member = workspace.members.find(member => String(member.user) === String(id));
      const account = await User.findById(id).session(session);
      if (account?.role === 'superadmin' && req.user.role !== 'superadmin') throw new SmartpingError('Platform accounts can only be managed by Super Admin.', 403);
      if (member.role === 'owner' && updates.role !== undefined) throw new SmartpingError('Transfer workspace ownership through Super Admin before changing the owner role.', 409);
      if (updates.role && updates.role !== member.role && member.customPermissions != null) { member.customPermissions = null; member.permissionVersion = (member.permissionVersion || 0) + 1; }
      Object.assign(member, updates);
      if (!['agent','supervisor'].includes(member.role)) { member.visibility = 'assigned'; member.allowedNumbers = []; }
      if (updates.disabled === true || updates.role && !['owner','admin'].includes(updates.role) && ['owner','admin'].includes(target.role)) {
        const activeChats = await Conversation.find({ workspace: workspace._id, assignedTo: id, status: { $ne: 'closed' } }).select('_id').session(session).lean();
        const reassigned = await Conversation.updateMany({ workspace: workspace._id, assignedTo: id, status: { $ne: 'closed' } }, { $set: { assignedTo: null }, $inc: { version: 1 } }, { session });
        for (const chat of activeChats) await activity(req, chat._id, 'agent-disabled-unassigned', undefined, { from: id, to: null }, session);
        await audit(req, 'user.chats-unassigned', 'User', id, 'success', session);
        await User.updateOne({ _id: id }, { $inc: { sessionVersion: 1 } }, { session });
        updates.unassignedChats = reassigned.modifiedCount;
      }
      await workspace.save({ session }); await audit(req, updates.disabled === true ? 'user.disable' : 'user.role-or-access-change', 'User', id, 'success', session);
      return { user: id, ...updates };
    });
    res.json({ item });
  } catch (error) { next(error); }
});
async function issueInvitation(req, existing) {
  let origin;
  try { origin = new URL(process.env.CLIENT_URL || 'http://localhost:5173'); } catch { throw new SmartpingError('Configure a valid CLIENT_URL before issuing invitations.', 409); }
  if (origin.username || origin.password || !['http:','https:'].includes(origin.protocol) || process.env.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new SmartpingError('Configure an HTTPS CLIENT_URL before issuing invitations.', 409);
  const email = String(existing?.email || req.body.email || '').trim().toLowerCase();
  const role = existing?.role || req.body.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !WORKSPACE_ROLES.includes(role)) throw new SmartpingError('Valid email and Business Admin, Agent or Supervisor role are required.');
  const token = randomBytes(32).toString('hex');
  const purpose = existing?.purpose || req.body.purpose || 'invite';
  if (!['invite','reset'].includes(purpose)) throw new SmartpingError('Invalid invitation purpose.');
  if (purpose === 'reset') {
    const user = await User.findOne({ email, isActive: true, deletedAt: null });
    if (user?.role === 'superadmin' && req.user.role !== 'superadmin') throw new SmartpingError('Platform accounts can only be managed by Super Admin.', 403);
    if (!user || !req.workspace.members.some(member => String(member.user) === String(user._id) && !member.disabled && ['owner','admin','agent','supervisor'].includes(member.role))) throw new SmartpingError('Only active business members can receive password setup/reset links.');
  }
  const fields = { workspace: req.workspace._id, email, role, name: existing?.name || req.body.name, purpose, tokenHash: hash(token), invitedBy: req.user._id, expiresAt: new Date(Date.now() + 48 * 3600000), acceptedAt: null, deliveryStatus: 'manual-link' };
  const invitation = await businessTransaction(req, async (workspace, session, actor) => {
    assertActorPermission(workspace, actor, req.user.role, 'team.manage');
    if (purpose === 'invite') assertCreationRole(workspace, role, req.user.role);
    const result = existing ? await BusinessInvitation.findOneAndUpdate({ _id: existing._id, workspace: req.workspace._id, acceptedAt: null }, { $set: fields }, { new: true, runValidators: true, session }) : (await BusinessInvitation.create([fields], { session }))[0];
    return result;
  });
  if (!invitation) throw new SmartpingError('Invitation is already accepted.', 409);
  await audit(req, existing ? 'invitation.resend' : 'invitation.create', 'BusinessInvitation', invitation._id);
  origin.searchParams.set('invitation', token);
  return { item: { _id: invitation._id, email, role, expiresAt: invitation.expiresAt, deliveryStatus: 'manual-link' }, link: origin.toString(), message: 'Secure link created. Share it privately; automatic invitation email delivery is not configured.' };
}
router.post('/invitations', adminOnly, async (req, res, next) => { try { res.status(201).json(await issueInvitation(req)); } catch (error) { next(error); } });
router.post('/invitations/:id/resend', adminOnly, async (req, res, next) => {
  try { const item = await BusinessInvitation.findOne({ _id: objectId(req.params.id), workspace: req.workspace._id, acceptedAt: null }); if (!item) throw new SmartpingError('Invitation not found.', 404); res.json(await issueInvitation(req, item)); } catch (error) { next(error); }
});

router.get('/contacts', async (req, res, next) => {
  try {
    const { offset, limit } = page(req); const filter = await recordScope(req, 'contacts');
    if (req.query.archived !== 'true') filter.archivedAt = null;
    if (req.query.q) filter.$or = ['name','phone','email','company'].map(field => ({ [field]: { $regex: escape(req.query.q), $options: 'i' } }));
    if (req.query.tag) filter.tags = String(req.query.tag);
    if (req.query.owner) filter.owner = objectId(req.query.owner);
    if (req.query.segment) { if(!req.permissions.includes('segments.read') && !isAdmin(req)) throw new SmartpingError('Segment read access is required.',403); const segment=await Segment.findOne({_id:objectId(req.query.segment),workspace:req.workspace._id});if(!segment)throw new SmartpingError('Segment not found.',404);if(segment.criteria?.contactIds?.length)filter._id={$in:segment.criteria.contactIds};if(segment.criteria?.tags?.length)filter.tags={$in:segment.criteria.tags}; }
    if (req.query.consent) filter.subscribed = req.query.consent === 'opted-in';
    res.json({ items: await Contact.find(filter).sort({ updatedAt: -1 }).skip(offset).limit(limit).lean(), total: await Contact.countDocuments(filter) });
  } catch (error) { next(error); }
});
router.get('/contacts/export', adminOnly, async (req, res, next) => {
  try {
    const items = await Contact.find({ ...(await recordScope(req, 'contacts')), archivedAt: null, ...(req.query.tag ? { tags: String(req.query.tag) } : {}) }).limit(10000).lean();
    await audit(req, 'contacts.export', 'Contact', 'export');
    res.json({ fileName: 'contacts.csv', content: csv([['name','phone','email','company','tags','subscribed','optInSource','optInAt'], ...items.map(item => [item.name,item.phone,item.email,item.company,item.tags.join(';'),item.subscribed,item.optInSource,item.optInAt?.toISOString()])]) });
  } catch (error) { next(error); }
});
router.post('/contacts/import', adminOnly, async (req, res, next) => {
  try {
    const rows = parseContactCsv(req.body.csv);
    const existing = await Contact.find({ workspace: req.workspace._id }).select('phone normalizedPhone').lean();
    const phones = new Map(); const duplicates = new Set();
    for (const contact of existing) { try { const phone = contact.normalizedPhone || phoneNumber(contact.phone); if (phones.has(phone)) duplicates.add(phone); phones.set(phone, contact._id); } catch { /* Existing invalid numbers remain unchanged. */ } }
    for (const row of rows) if (row.status === 'valid' && phones.has(row.contact.phone)) row.status = duplicates.has(row.contact.phone) ? 'ambiguous-existing-duplicate' : 'duplicate-business';
    if (!req.body.confirm) return res.json({ rows, preview: true });
    if (!['skip','update'].includes(req.body.duplicates)) throw new SmartpingError('Choose skip or update duplicate contacts.');
    let created = 0, updated = 0;
    for (const row of rows) {
      if (!['valid','duplicate-business'].includes(row.status)) continue;
      const body = safeContactInput(row.contact, req);
      if (isAgent(req) && !body.owner) body.owner = req.user._id;
      if (row.status === 'valid') { await createWithCapacity(req, 'contacts', Contact, { ...body, workspace: req.workspace._id }); created++; }
      else if (row.status === 'duplicate-business' && req.body.duplicates === 'update') {
        // Importing a duplicate never overrides existing consent or opt-out.
        for (const key of ['subscribed','optInAt','optInSource','optOutAt']) delete body[key];
        const write = await Contact.updateOne({ ...(await recordScope(req, 'contacts', { write: true })), _id: phones.get(row.contact.phone) }, { $set: body }); if (write.modifiedCount) updated++;
      }
    }
    await audit(req, 'contacts.import', 'Contact', 'import'); res.json({ created, updated, skipped: rows.length - created - updated });
  } catch (error) { next(error); }
});
router.get('/contacts/:id/history', async (req, res, next) => {
  try {
    const id = objectId(req.params.id);
    if (!await Contact.exists({ ...(await recordScope(req, 'contacts')), _id: id })) throw new SmartpingError('Contact not found.', 404);
    res.json({ conversations: await Conversation.find({ ...conversationScope(req), contact: id }).sort({ createdAt: -1 }).limit(100).lean(), notes: await ContactNote.find({ workspace: req.workspace._id, contact: id }).populate('actor','name').sort({ createdAt: -1 }).limit(100).lean() });
  } catch (error) { next(error); }
});
router.post('/contacts/:id/notes', async (req, res, next) => {
  try {
    const id = objectId(req.params.id);
    if (!await Contact.exists({ ...(await recordScope(req, 'contacts', { write: true })), _id: id })) throw new SmartpingError('Contact not found.', 404);
    const item = await ContactNote.create({ workspace: req.workspace._id, contact: id, actor: req.user._id, text: req.body.text }); res.status(201).json({ item });
  } catch (error) { next(error); }
});
router.post('/contacts/:id/archive', adminOnly, async (req, res, next) => {
  try { if (req.body.confirm !== true) throw new SmartpingError('Confirm contact archival.'); const item = await Contact.findOneAndUpdate({ ...(await recordScope(req, 'contacts', { write: true })), _id: objectId(req.params.id) }, { $set: { archivedAt: new Date(), subscribed: false, optOutAt: new Date() } }, { new: true }); if (!item) throw new SmartpingError('Contact not found.', 404); await audit(req, 'contact.archive', 'Contact', item._id); res.json({ item }); } catch (error) { next(error); }
});
router.get('/audit', adminOnly, async (req, res, next) => {
  try { const { offset, limit } = page(req); const filter = { workspace: req.workspace._id, ...(req.query.action ? { action: String(req.query.action) } : {}) }; res.json({ items: await BusinessAudit.find(filter).populate('actor','name email').sort({ createdAt: -1 }).skip(offset).limit(limit).lean(), total: await BusinessAudit.countDocuments(filter) }); } catch (error) { next(error); }
});
export default router;
