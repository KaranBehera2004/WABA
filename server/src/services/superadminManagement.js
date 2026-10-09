import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { SmartpingError } from './smartping.js';
import { assertLastAdmin } from './businessPolicy.js';

// Optional workspace context keeps the global Users/Security tools compatible.
export async function managementScope(req, session) {
  if (req.body.workspace === undefined) return;
  if (typeof req.body.workspace !== 'string' || !mongoose.isValidObjectId(req.body.workspace)) throw new SmartpingError('Invalid workspace ID.');
  let query = Workspace.findOne({ _id: req.body.workspace, deletedAt: null, 'members.user': req.params.id });
  if (session) query = query.session(session);
  const workspace = await query;
  if (!workspace) throw new SmartpingError('Account is not a member of this workspace.', 404);
  req.workspace = workspace;
}

export function mergeManagedMembers(previous, members) {
  return members.map(member => {
    const existing = previous.find(item => String(item.user) === String(member.user));
    const retained = existing?.toObject ? existing.toObject() : { ...existing || {} };
    if (existing && existing.role !== member.role && existing.customPermissions != null) { retained.customPermissions = null; retained.permissionVersion = (existing.permissionVersion || 0) + 1; }
    return { ...retained, user: member.user, role: member.role,
      joinedAt: existing?.joinedAt || new Date(), disabled: member.disabled ?? existing?.disabled ?? false };
  });
}

export async function protectBusinessAdmins(userId, session) {
  const workspaces = await Workspace.find({ deletedAt: null, 'members.user': userId }).sort({ _id: 1 }).session(session);
  for (const workspace of workspaces) {
    // Share the business routing lock with concurrent business role changes.
    await Workspace.updateOne({ _id: workspace._id }, { $inc: { capacityVersion: 1 } }, { session });
    const active = new Set((await User.find({ _id: { $in: workspace.members.map(member => member.user) }, isActive: true, deletedAt: null }).select('_id').session(session)).map(user => String(user._id)));
    assertLastAdmin(workspace.members.map(member => ({ ...member.toObject(), disabled: member.disabled || !active.has(String(member.user)) })), userId, { disabled: true });
  }
}
