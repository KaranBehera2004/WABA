import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { Conversation } from '../models/Domain.js';
import { BusinessTeam, WhatsAppNumber } from '../models/Business.js';
import { activity, audit, eligibleMembers, isAdmin, membershipCanClaim, notify, objectId, conversationScope, hasCapability } from './businessPolicy.js';
import { SmartpingError } from './smartping.js';
import { permissionsFor, requestCapability, WORKSPACE_ROLES } from './accessControl.js';

// Serialize every assignment and membership edit on the business document in a
// Mongo transaction. The conversation compare-and-set prevents double claims;
// the business lock prevents two different chats exceeding one agent's capacity.
export async function businessTransaction(req, operation) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const workspace = await Workspace.findOneAndUpdate({ _id: req.workspace._id, deletedAt: null }, { $inc: { capacityVersion: 1 } }, { new: true, session });
      if (!workspace) throw new SmartpingError('Business is unavailable.', 404);
      const actor = workspace.members.find(member => String(member.user) === String(req.user._id));
      if (req.user.role !== 'superadmin' && (!actor || actor.disabled || !['owner', ...WORKSPACE_ROLES].includes(actor.role))) throw new SmartpingError('Business access has been revoked.', 403);
      const capability = req.originalUrl && requestCapability(req.method, req.originalUrl.split('?')[0]);
      if (capability && req.user.role !== 'superadmin' && !permissionsFor(workspace, actor, req.user.role).includes(capability)) throw new SmartpingError('Permission was revoked. Refresh business access.', 403);
      result = await operation(workspace, session, actor);
    });
    return result;
  } finally { await session.endSession(); }
}
export async function assignConversation(req, id, { assignedTo, team, strategy = 'manual', claim = false, takeover = false, expectedVersion } = {}) {
  objectId(id);
  if (!hasCapability(req, 'conversations.assign') && !claim) throw new SmartpingError('Ask a Business Admin to reassign the conversation.', 403);
  if (claim && !isAdmin(req) && !membershipCanClaim(req)) throw new SmartpingError('Claiming unassigned chats is not enabled.', 403);
  return businessTransaction(req, async (workspace, session) => {
    const actor = workspace.members.find(member => String(member.user) === String(req.user._id));
    if (claim && req.user.role !== 'superadmin' && !['owner','admin'].includes(actor?.role) && !membershipCanClaim({ ...req, workspace, membership: actor, permissions: permissionsFor(workspace, actor, req.user.role) })) throw new SmartpingError('Claim permission was revoked.', 403);
    const fresh = { ...req, workspace, membership: actor, permissions: permissionsFor(workspace, actor, req.user.role) };
    if (!claim && !hasCapability(fresh, 'conversations.assign')) throw new SmartpingError('Assignment permission was revoked.',403);
    const chat = await Conversation.findOne({ ...conversationScope(fresh, { write: !claim, unassigned: claim }), _id: id }).session(session);
    if (!chat) throw new SmartpingError('Conversation not found.', 404);
    if (expectedVersion !== undefined && chat.version !== expectedVersion) throw new SmartpingError('Assignment changed. Refresh the conversation.', 409);
    if (claim && (chat.assignedTo || chat.status === 'closed')) throw new SmartpingError('Another user already assigned this chat, or it is resolved.', 409);
    if (team && !await BusinessTeam.exists({ _id: objectId(team), workspace: workspace._id, archivedAt: null }).session(session)) throw new SmartpingError('Choose an active business team.');
    if (team && !isAdmin(fresh) && !actor.teams?.some(id => String(id) === String(team))) throw new SmartpingError('Choose a team assigned to you.', 403);
    const number=chat.number?await WhatsAppNumber.findOne({ _id: chat.number, workspace: workspace._id, disconnectedAt:null }).session(session):null;
    if (chat.number && !number) throw new SmartpingError('Conversation number does not belong to this business or is disconnected.');
    const users = await User.find({ _id: { $in: workspace.members.map(member => member.user) }, isActive: true, deletedAt: null }).session(session).lean();
    const chats = await Conversation.find({ workspace: workspace._id, status: { $ne: 'closed' }, _id: { $ne: chat._id } }).session(session).lean();
    const candidates = eligibleMembers(workspace, users, chats, { team: team || chat.team, number: chat.number }).filter(member=>!number?.teams?.length||member.teams?.some(team=>number.teams.some(mapped=>String(mapped)===String(team))));
    let target = claim ? req.user._id : assignedTo;
    if (strategy !== 'manual') {
      if (!['round-robin', 'least-active', 'team'].includes(strategy)) throw new SmartpingError('Invalid routing strategy.');
      const workload = member => chats.filter(item => String(item.assignedTo) === String(member.user)).length;
      if (strategy === 'least-active' || strategy === 'team') candidates.sort((a, b) => workload(a) - workload(b) || String(a.user).localeCompare(String(b.user)));
      else candidates.sort((a, b) => {
        const latest = member => member.lastAssignedAt ? +new Date(member.lastAssignedAt) : 0;
        return latest(a) - latest(b) || String(a.user).localeCompare(String(b.user));
      });
      target = candidates[0]?.user || null;
    }
    if (takeover) target = req.user._id;
    if (target) {
      const member = workspace.members.find(item => String(item.user) === String(target) && !item.disabled);
      const adminTakeover = takeover && hasCapability(fresh, 'conversations.assign') && String(target) === String(req.user._id);
      if (!adminTakeover && !candidates.some(member => String(member.user) === String(target))) throw new SmartpingError('Agent is unavailable, at capacity, or outside the selected team/number.', 409);
    }
    const previous = chat.assignedTo;
    const item = await Conversation.findOneAndUpdate({ _id: chat._id, workspace: workspace._id, version: chat.version, ...(claim ? { assignedTo: null } : {}) }, { $set: { assignedTo: target || null, ...(team !== undefined ? { team: team || null } : {}), ...(takeover ? { humanTakeover: true } : {}) }, $inc: { version: 1 } }, { new: true, session, runValidators: true });
    if (!item) throw new SmartpingError('Assignment changed. Refresh and try again.', 409);
    if (target) await Workspace.updateOne({ _id: workspace._id, 'members.user': target }, { $set: { 'members.$.lastAssignedAt': new Date() } }, { session });
    await activity(req, item._id, takeover ? 'admin-takeover' : claim ? 'claimed' : 'assigned', undefined, { from: previous, to: target || null, team: item.team }, session);
    await audit(req, takeover ? 'conversation.takeover' : 'conversation.assign', 'Conversation', item._id, 'success', session);
    if (previous && takeover && String(previous) !== String(target)) await notify(workspace._id, previous, 'takeover', 'A Business Admin took over your conversation', item._id, session);
    if (target && String(previous) !== String(target)) await notify(workspace._id, target, 'assignment', 'A conversation was assigned to you', item._id, session);
    return item;
  });
}
