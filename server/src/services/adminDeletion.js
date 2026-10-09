import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { Campaign, Conversation, CallLog } from '../models/Domain.js';
import { PlatformSettings } from '../models/Platform.js';
import { SmartpingError } from './smartping.js';

const fail = (message, status = 400) => { throw new SmartpingError(message, status); };
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const confirmationFor = resource => resource === 'users' ? 'DELETE USERS' : 'DELETE WORKSPACES';
const issuer = 'waba-deletion-preview';
const target = item => ({ id: String(item._id), name: item.name || String(item._id), ...(item.email ? { email: item.email } : {}) });
const query = (request, session) => session ? request.session(session) : request;

export function validateDeletionSelection(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['resource', 'scope', 'ids'].includes(key))) fail('Provide only a deletion resource, scope and selected IDs.');
  if (!['users', 'workspaces'].includes(body.resource) || !['all', 'selected'].includes(body.scope)) fail('Choose users or workspaces and a supported deletion scope.');
  if (body.scope === 'all') {
    if (body.ids !== undefined) fail('Delete all must not contain selected IDs.');
    return { resource: body.resource, scope: body.scope };
  }
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || body.ids.some(id => !validId(id)) || new Set(body.ids.map(id => id.toLowerCase())).size !== body.ids.length) fail('Choose 1 to 200 distinct valid records.');
  return { resource: body.resource, scope: body.scope, ids: body.ids.map(id => id.toLowerCase()) };
}

async function partition(resource, items, actorId, session) {
  if (resource === 'workspaces') return { eligible: items, protected: [] };
  const owned = await query(Workspace.find({ deletedAt: null, owner: { $in: items.map(item => item._id) } }).select('owner'), session).lean();
  const owners = new Set(owned.map(item => String(item.owner)));
  const activeRoots = await query(User.find({ deletedAt: null, role: 'superadmin', isActive: true }).select('_id'), session).lean();
  const candidates = new Set(items.filter(item => String(item._id) !== actorId && !owners.has(String(item._id))).map(item => String(item._id)));
  // Usually the current actor is the retained root. This also guards inconsistent
  // snapshots and protects one root deterministically if all remaining roots are targets.
  const retainedRoot = activeRoots.some(item => !candidates.has(String(item._id))) ? null : String(activeRoots[0]?._id || '');
  const eligible = [], protectedRecords = [];
  for (const item of items) {
    const id = String(item._id);
    const reason = id === actorId ? 'Your signed-in superadmin account cannot be deleted.' : owners.has(id) ? 'Owns an undeleted business. Transfer ownership or delete its workspace first.' : id === retainedRoot ? 'The last active superadmin must be retained.' : '';
    if (reason) protectedRecords.push({ ...target(item), reason }); else eligible.push(item);
  }
  return { eligible, protected: protectedRecords };
}

export async function previewAdminDeletion(body, actor) {
  const selection = validateDeletionSelection(body);
  const Model = selection.resource === 'users' ? User : Workspace;
  const filter = { deletedAt: null, ...(selection.ids ? { _id: { $in: selection.ids } } : {}) };
  const items = await Model.find(filter).select('_id name email role isActive').sort({ _id: 1 }).limit(1001).lean();
  if (items.length > 1000) fail('More than 1000 records match. Delete selected batches instead of one oversized operation.', 409);
  if (selection.ids && items.length !== selection.ids.length) fail('One or more selected records are missing or already deleted. Refresh the list.', 409);
  const split = await partition(selection.resource, items, String(actor._id));
  const claims = { actor: String(actor._id), version: actor.sessionVersion || 0, resource: selection.resource, scope: selection.scope, ids: split.eligible.map(item => String(item._id)), protectedIds: split.protected.map(item => item.id) };
  const token = jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256', issuer, expiresIn: '10m' });
  return { resource: selection.resource, scope: selection.scope, token, confirmation: confirmationFor(selection.resource), targets: split.eligible.map(target), protected: split.protected, matchedCount: items.length };
}

export function verifyDeletionRequest(body, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['token', 'confirmation'].includes(key)) || typeof body.token !== 'string' || body.token.length > 65536) fail('Provide the signed deletion preview and its confirmation.');
  let claims;
  try { claims = jwt.verify(body.token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer }); }
  catch { fail('The deletion preview is invalid or expired. Refresh the preview.', 409); }
  if (claims.actor !== String(actor._id) || claims.version !== (actor.sessionVersion || 0)) fail('This deletion preview belongs to a different account or session.', 403);
  if (!['users', 'workspaces'].includes(claims.resource) || !['all', 'selected'].includes(claims.scope) || !Array.isArray(claims.ids) || !Array.isArray(claims.protectedIds) || claims.ids.length + claims.protectedIds.length > 1000 || [...claims.ids, ...claims.protectedIds].some(id => !validId(id)) || new Set([...claims.ids, ...claims.protectedIds]).size !== claims.ids.length + claims.protectedIds.length) fail('Invalid deletion snapshot.', 409);
  if (body.confirmation !== confirmationFor(claims.resource)) fail(`Type ${confirmationFor(claims.resource)} exactly to confirm.`);
  if (!claims.ids.length) fail('There are no eligible records in this preview.');
  return claims;
}

export async function executeAdminDeletion(body, actor) {
  const claims = verifyDeletionRequest(body, actor);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Shares the privilege/ownership mutation lock with admin user changes,
      // ownership transfers and membership invitations.
      await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $inc: { controlVersion: 1 } }, { upsert: true, session });
      const currentActor = await User.findById(actor._id).session(session);
      if (!currentActor || currentActor.deletedAt || !currentActor.isActive || currentActor.role !== 'superadmin' || (currentActor.sessionVersion || 0) !== claims.version) fail('Your administrator access changed. Sign in and preview again.', 403);
      const Model = claims.resource === 'users' ? User : Workspace;
      const items = await Model.find({ deletedAt: null, _id: { $in: [...claims.ids, ...claims.protectedIds] } }).select('_id name email role isActive').session(session).lean();
      const originalProtected = new Set(claims.protectedIds);
      const eligibleSnapshot = items.filter(item => !originalProtected.has(String(item._id)));
      const split = await partition(claims.resource, eligibleSnapshot, claims.actor, session);
      // Records shown as protected were NOT confirmed for deletion, even if
      // their role/ownership changes after preview. A new preview is required.
      const held = items.filter(item => originalProtected.has(String(item._id)));
      const heldSplit = await partition(claims.resource, held, claims.actor, session);
      const reasons = new Map(heldSplit.protected.map(item => [item.id, item.reason]));
      const protectedRecords = [...split.protected, ...held.map(item => ({ ...target(item), reason: reasons.get(String(item._id)) || 'Protected in the confirmed preview. Start a new preview to select this record.' }))];
      const ids = split.eligible.map(item => item._id);
      const now = new Date();
      let deletedCount = 0;
      if (ids.length && claims.resource === 'users') {
        const changed = await User.updateMany({ _id: { $in: ids }, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actor._id, isActive: false, autoWorkspaceCreationBlocked: true }, $inc: { sessionVersion: 1 } }, { session });
        deletedCount = changed.modifiedCount;
        await Workspace.updateMany({ deletedAt: null, 'members.user': { $in: ids } }, { $pull: { members: { user: { $in: ids } } }, $inc: { capacityVersion: 1 } }, { session });
        for (const Model of [Conversation, CallLog]) await Model.updateMany({ assignedTo: { $in: ids } }, { $unset: { assignedTo: '' } }, { session });
      } else if (ids.length) {
        const changed = await Workspace.updateMany({ _id: { $in: ids }, deletedAt: null }, { $set: { deletedAt: now, deletedBy: actor._id, isActive: false, sendingEnabled: false }, $inc: { capacityVersion: 1 } }, { session });
        deletedCount = changed.modifiedCount;
        await Campaign.updateMany({ workspace: { $in: ids }, status: 'Running' }, { $set: { status: 'Paused' } }, { session });
        const users = await User.find({ deletedAt: null, defaultWorkspace: { $in: ids } }).select('_id defaultWorkspace').session(session).lean();
        for (const user of users) {
          const fallback = await Workspace.findOne({ deletedAt: null, _id: { $nin: ids }, 'members.user': user._id }).select('_id').sort({ createdAt: 1 }).session(session).lean();
          const updates = fallback ? { $set: { defaultWorkspace: fallback._id, autoWorkspaceCreationBlocked: false } } : { $unset: { defaultWorkspace: '' }, $set: { autoWorkspaceCreationBlocked: true } };
          await User.updateOne({ _id: user._id, deletedAt: null, defaultWorkspace: { $in: ids } }, updates, { session });
        }
      }
      result = { resource: claims.resource, deletedCount, protectedCount: protectedRecords.length, protected: protectedRecords, alreadyDeletedCount: claims.ids.length - eligibleSnapshot.length };
    });
  } finally { await session.endSession(); }
  return result;
}
