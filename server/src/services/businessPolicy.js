import mongoose from 'mongoose';
import { requestCapability } from './accessControl.js';
import { Conversation } from '../models/Domain.js';
import { BusinessAudit, BusinessNotification, ConversationActivity } from '../models/Business.js';
import { SmartpingError, phoneNumber } from './smartping.js';

export const isAgent = req => req.user.role !== 'superadmin' && ['agent', 'supervisor'].includes(req.membership?.role);
export const isAdmin = req => req.user.role === 'superadmin' || ['owner', 'admin'].includes(req.membership?.role);
export const hasCapability = (req, capability) => req.user.role === 'superadmin' || req.membership?.role === 'owner' || Boolean(req.permissions?.includes(capability));
export function adminOnly(req, res, next) {
  const capability = requestCapability(req.method, (req.originalUrl || '').split('?')[0]);
  return isAdmin(req) || req.permissionDecision === true && capability && hasCapability(req, capability) ? next() : res.status(403).json({ message: 'This business action requires an explicit permission grant.' });
}
export const objectId = value => {
  if (!mongoose.isValidObjectId(value) || typeof value !== 'string' && !(value instanceof mongoose.Types.ObjectId)) throw new SmartpingError('Invalid record ID.');
  return new mongoose.Types.ObjectId(String(value));
};
export function conversationScope(req, { write = false, unassigned = false } = {}) {
  const filter = { workspace: req.workspace._id };
  if (!isAgent(req)) return filter;
  const membership = req.membership;
  const own = { assignedTo: req.user._id };
  const choices = [own];
  if ((membership.role === 'supervisor' || !write && membership.visibility === 'teams') && membership.teams?.length) choices.push({ team: { $in: membership.teams } });
  if (!write && unassigned && membershipCanClaim(req)) choices.push({ assignedTo: null, status: { $ne: 'closed' } });
  filter.$and = [{ $or: choices }, { $or: [{ number: { $in: membership.allowedNumbers || [] } }, { number: null }] }];
  return filter;
}
export function membershipCanClaim(req) { return Boolean(req.workspace.settings?.routing?.allowClaim && req.permissions?.includes('conversations.claim')); }
export async function recordScope(req, resource, options = {}) {
  const filter = { workspace: req.workspace._id };
  if (!isAgent(req)) return filter;
  if (resource === 'conversations') return conversationScope(req, options);
  if (resource === 'contacts') return { ...filter, $or: [{ _id: { $in: await Conversation.distinct('contact', conversationScope(req, options)) } }, { owner: req.user._id }] };
  if (resource === 'calls') {
    const users = req.membership.role === 'supervisor' ? req.workspace.members.filter(member => !member.disabled && member.teams?.some(team => req.membership.teams?.some(id => String(id) === String(team)))).map(member => member.user) : [req.user._id];
    return { ...filter, assignedTo: { $in: users } };
  }
  if (resource === 'templates') return hasCapability(req, 'templates.update') || hasCapability(req, 'templates.create') ? filter : { ...filter, status: 'Approved' };
  if (req.permissions?.some(permission => permission.startsWith(resource + '.'))) return filter;
  throw new SmartpingError('This business module has not been granted to your role.', 403);
}
export function agentPathAllowed(method, path) {
  if (/\/(wallet|campaigns|automations|reports|dashboards|segments|ads|analytics)(\/|$)/.test(path)) return false;
  if (/\/integrations\//.test(path)) return method === 'GET' && path.endsWith('/smartping/status');
  if (path.startsWith('/api/business/')) return /^\/api\/business\/(me|notifications|quick-replies|tags|conversations|contacts)(\/|$)/.test(path);
  return true;
}
export function safeContactInput(body, req) {
  const fields = isAgent(req) && !hasCapability(req, 'contacts.create') ? [...(req.workspace.settings?.editableAgentFields || ['name', 'email', 'company']), 'tags'] : ['name', 'phone', 'email', 'company', 'customFields', 'tags', 'owner', 'source', 'subscribed', 'optInSource', 'optInAt', 'optOutAt', 'archivedAt'];
  const allowed = ['name', 'phone', 'email', 'company', 'customFields', 'tags', 'owner', 'source', 'subscribed', 'optInSource', 'optInAt', 'optOutAt', 'archivedAt'];
  const result = Object.fromEntries(Object.entries(body).filter(([key]) => fields.includes(key) && allowed.includes(key)));
  if (result.phone !== undefined) result.normalizedPhone = result.phone = phoneNumber(result.phone);
  if (result.subscribed === false) result.optOutAt = new Date();
  if (result.subscribed === true && !result.optInAt) throw new SmartpingError('Record the opt-in date and source before enabling WhatsApp consent.');
  if (result.subscribed === true && result.optInAt) result.optOutAt = null;
  if (result.optInAt && (!result.optInSource || !Number.isFinite(Date.parse(result.optInAt)) || Date.parse(result.optInAt) > Date.now())) throw new SmartpingError('A valid opt-in date and source are required; the date cannot be in the future.');
  if (result.owner && !req.workspace.members.some(member => String(member.user) === String(result.owner) && !member.disabled && ['owner', 'admin', 'agent', 'supervisor'].includes(member.role))) throw new SmartpingError('Contact owner must be an active business member.');
  if (result.customFields && (typeof result.customFields !== 'object' || Array.isArray(result.customFields) || Object.keys(result.customFields).some(key => !req.workspace.settings?.contactFields?.includes(key)))) throw new SmartpingError('Use configured contact custom fields only.');
  return result;
}
export function assertLastAdmin(members, userId, updates) {
  const target = members.find(member => String(member.user) === String(userId));
  if (!target) throw new SmartpingError('Business member not found.', 404);
  if (['owner', 'admin'].includes(target.role) && !target.disabled && (updates.disabled === true || updates.role !== undefined && !['owner','admin'].includes(updates.role))) {
    if (!members.some(member => String(member.user) !== String(userId) && !member.disabled && ['owner', 'admin'].includes(member.role))) throw new SmartpingError('The last active Business Admin cannot be disabled or demoted.', 409);
  }
  return target;
}
export function eligibleMembers(workspace, users, conversations, { team, number } = {}) {
  const activeUsers = new Set(users.filter(user => user.isActive && !user.deletedAt).map(user => String(user._id)));
  return workspace.members.filter(member => member.role === 'agent' && !member.disabled && activeUsers.has(String(member.user)) && member.availability === 'available' && (!team || member.teams?.some(id => String(id) === String(team))) && (!number || member.allowedNumbers?.some(id => String(id) === String(number))) && conversations.filter(chat => String(chat.assignedTo) === String(member.user) && chat.status !== 'closed').length < (member.capacity || 10));
}
export async function audit(req, action, recordType, recordId, result = 'success', session) {
  // Deliberately no payload/details field: credentials and customer message bodies
  // can never enter the audit log through request serialization.
  return BusinessAudit.create([{ workspace: req.workspace._id, actor: req.user._id, action, recordType, recordId: String(recordId || ''), result }], session ? { session } : {});
}
export async function activity(req, conversation, action, text, details, session) {
  return ConversationActivity.create([{ workspace: req.workspace._id, conversation, actor: req.user._id, action, text, details }], session ? { session } : {});
}
export async function notify(workspace, user, type, title, recordId, session) {
  return BusinessNotification.create([{ workspace, user, type, title, recordId: String(recordId || '') }], session ? { session } : {});
}
