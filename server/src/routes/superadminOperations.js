import { Router } from 'express';
import mongoose from 'mongoose';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { Message } from '../models/Domain.js';
import { PlatformAnnouncement } from '../models/Platform.js';
import { CAPABILITIES, CAPACITY_KEYS, DEFAULT_PERMISSIONS, ROLE_PERMISSION_LIMITS, rolePermissionLimit, workspaceRolePolicy, validateRolePolicy, permissionsFor, validateCapacities, validatePermissionRules, WORKSPACE_ROLES } from '../services/accessControl.js';
import { usageFor } from '../services/capacity.js';
import { SmartpingError } from '../services/smartping.js';
import { csv } from '../services/metrics.js';
import { managementScope } from '../services/superadminManagement.js';

const wrap = fn => async (req, res, next) => { try { await fn(req, res); } catch (error) { next(error); } };
const fail = (message, status = 400) => { throw new SmartpingError(message, status); };
const validId = value => { if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail('A valid record ID is required.'); return value; };
const pick = (body, keys) => Object.fromEntries(keys.filter(key => body[key] !== undefined).map(key => [key, body[key]]));
const pageOf = req => Math.max(1, Math.floor(Number(req.query.page) || 1));
const workspaceFor = async req => {
  const item = await Workspace.findById(validId(req.params.workspaceId || req.query.workspace));
  if (!item || item.deletedAt) fail('Workspace not found.', 404);
  req.workspace = item; return item;
};

// Mounted beneath the existing authentication + superadmin guard.
export default function operations(resources) {
  const router = Router();
  router.get('/workspaces/:workspaceId/role-policy', wrap(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ workspace: { _id: workspace._id, name: workspace.name }, policy: workspaceRolePolicy(workspace), version: workspace.rolePolicyVersion || 0, roles: WORKSPACE_ROLES, capabilities: CAPABILITIES, defaults: DEFAULT_PERMISSIONS });
  }));
  router.put('/workspaces/:workspaceId/role-policy', wrap(async (req, res) => {
    if (!validateRolePolicy(req.body.policy)) fail('Choose known creation roles and distinct business feature permissions.');
    if (!Number.isSafeInteger(req.body.expectedVersion) || req.body.expectedVersion < 0) fail('Reload the role configuration before saving.');
    const session = await mongoose.startSession();
    try { await session.withTransaction(async () => {
      const workspace = await Workspace.findOneAndUpdate({ _id: validId(req.params.workspaceId), deletedAt: null }, { $inc: { capacityVersion: 1 } }, { new: true, session });
      if (!workspace) fail('Workspace not found.', 404);
      if ((workspace.rolePolicyVersion || 0) !== req.body.expectedVersion) fail('Role access changed. Reload before saving.', 409);
      workspace.rolePolicy = req.body.policy;
      // Root selections also become the role's current permissions. Business
      // managers may later narrow them, never exceed the saved ceilings.
      workspace.permissionRules = req.body.policy.permissionCeilings;
      workspace.rolePolicyVersion = (workspace.rolePolicyVersion || 0) + 1;
      await workspace.save({ session }); req.workspace = workspace;
      req.auditDetails = { creationRoles: req.body.policy.creatableRoles, version: workspace.rolePolicyVersion };
    }); } finally { await session.endSession(); }
    res.json({ message: 'Workspace role creation and feature access saved.' });
  }));
  router.get('/workspaces/:workspaceId/members/:userId/permissions', wrap(async (req, res) => {
    const workspace = await workspaceFor(req);
    const userId = validId(req.params.userId);
    const member = workspace.members.find(item => String(item.user) === userId && item.role === 'agent');
    if (!member) fail('Agent is not a member of this business.', 404);
    res.json({ workspace: { _id: workspace._id, name: workspace.name }, member: { user: userId, role: member.role, disabled: Boolean(member.disabled) }, version: member.permissionVersion || 0, capabilities: rolePermissionLimit(workspace, 'agent'), inheritedPermissions: permissionsFor(workspace, { role: 'agent', canClaim: member.canClaim, customPermissions: null }, 'agent'), customPermissions: member.customPermissions ?? null, effectivePermissions: permissionsFor(workspace, member, 'agent') });
  }));
  router.put('/workspaces/:workspaceId/members/:userId/permissions', wrap(async (req, res) => {
    const workspaceId = validId(req.params.workspaceId), userId = validId(req.params.userId);
    const values = req.body.permissions;
    if (values !== null && (!Array.isArray(values) || new Set(values).size !== values.length || values.some(value => !CAPABILITIES.includes(value)))) fail('Choose supported Agent permissions or restore role defaults.');
    if (!Number.isSafeInteger(req.body.expectedVersion) || req.body.expectedVersion < 0) fail('Reload the Agent permission configuration before saving.');
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const workspace = await Workspace.findOneAndUpdate({ _id: workspaceId, deletedAt: null, members: { $elemMatch: { user: userId, role: 'agent' } } }, { $inc: { capacityVersion: 1 } }, { new: true, session });
        if (!workspace) fail('Agent is not a member of this business.', 404);
        const member = workspace.members.find(item => String(item.user) === userId && item.role === 'agent');
        if (!member) fail('Agent is not a member of this business.', 404);
        if ((member.permissionVersion || 0) !== req.body.expectedVersion) fail('Agent permissions changed. Reload before saving.', 409);
        if (values?.some(value => !rolePermissionLimit(workspace, 'agent').includes(value))) fail('Enable this feature in Roles & creation access before granting it to this Agent.', 400);
        member.customPermissions = values;
        member.permissionVersion = (member.permissionVersion || 0) + 1;
        await workspace.save({ session });
        req.workspace = workspace;
        req.auditDetails = { userId, restoredRoleDefaults: values === null, permissionCount: values?.length ?? null, version: member.permissionVersion };
      });
    } finally { await session.endSession(); }
    res.json({ message: values === null ? 'This Agent now inherits business role permissions.' : 'Custom permissions saved for this Agent in this business only.' });
  }));
  router.get('/permissions/:workspaceId', wrap(async (req, res) => {
    const workspace = await workspaceFor(req);
    res.json({ workspace: { _id: workspace._id, name: workspace.name }, roles: WORKSPACE_ROLES, capabilities: CAPABILITIES, allowedPermissions: Object.fromEntries(WORKSPACE_ROLES.map(role => [role, CAPABILITIES])), defaults: Object.fromEntries(WORKSPACE_ROLES.map(role => [role, DEFAULT_PERMISSIONS[role]])), rules: (workspace.permissionRules || []).filter(rule => WORKSPACE_ROLES.includes(rule.role)) });
  }));
  router.put('/permissions/:workspaceId', wrap(async (req, res) => {
    if (!validatePermissionRules(req.body.rules)) fail('Choose valid, unique business roles and permitted actions. Owner and Super Admin access is preserved.');
    const workspace = await workspaceFor(req);
    workspace.permissionRules = req.body.rules;
    const existing = workspaceRolePolicy(workspace);
    workspace.rolePolicy = { ...existing, permissionCeilings: WORKSPACE_ROLES.map(role => ({ role, permissions: req.body.rules.find(rule => rule.role === role)?.permissions ?? ROLE_PERMISSION_LIMITS[role] })) };
    workspace.rolePolicyVersion = (workspace.rolePolicyVersion || 0) + 1; await workspace.save();
    res.json({ message: 'Workspace permissions updated.', rules: workspace.permissionRules });
  }));
  router.get('/usage', wrap(async (req, res) => {
    if (!req.query.workspace) return res.json({ keys: CAPACITY_KEYS, items: [] });
    res.json({ keys: CAPACITY_KEYS, items: [await usageFor(await workspaceFor(req))] });
  }));
  router.patch('/usage/:workspaceId', wrap(async (req, res) => {
    if (!validateCapacities(req.body.limits)) fail('Limits must contain known resources and whole non-negative values or null for unlimited.');
    const workspace = await workspaceFor(req);
    workspace.limits = req.body.limits; await workspace.save();
    res.json({ message: 'Capacity overrides updated.' });
  }));
  router.get('/security', wrap(async (req, res) => {
    const page = pageOf(req);
    const filter = { deletedAt: null };
    if (req.query.role) { if (!['superadmin', 'owner', 'admin', 'agent', 'supervisor'].includes(req.query.role)) fail('Unknown account role.'); filter.role = req.query.role; }
    const [items, total] = await Promise.all([User.find(filter).select('name email role isActive lastLoginAt updatedAt sessionVersion').sort({ lastLoginAt: -1 }).skip((page - 1) * 50).limit(50).lean(), User.countDocuments(filter)]);
    res.json({ items, total, page, note: 'JWT sessions are stateless. Last login and revocation version are shown, not an invented active-session count.' });
  }));
  router.post('/security/users/:id/revoke', wrap(async (req, res) => {
    if (req.params.id === String(req.user._id)) fail('Use sign out for your own current account.');
    await managementScope(req);
    const item = await User.findOneAndUpdate({ _id: validId(req.params.id), deletedAt: null }, { $inc: { sessionVersion: 1 } }, { new: true });
    if (!item) fail('Account not found.', 404);
    res.json({ message: 'All existing sessions for this account were revoked.' });
  }));
  router.post('/security/revoke-others', wrap(async (req, res) => {
    if (req.body.confirmation !== 'REVOKE OTHER SESSIONS') fail('Explicit session revocation confirmation is required.');
    const filter = { _id: { $ne: req.user._id } };
    if (req.body.includeSuperadmins !== true) filter.role = { $ne: 'superadmin' };
    const result = await User.updateMany(filter, { $inc: { sessionVersion: 1 } });
    req.auditDetails = { affected: result.modifiedCount, includeSuperadmins: req.body.includeSuperadmins === true };
    res.json({ message: 'Other account sessions revoked.', affected: result.modifiedCount });
  }));
  router.post('/workspaces/bulk-control', wrap(async (req, res) => {
    const actions = { suspend: { isActive: false }, reactivate: { isActive: true }, pauseSending: { sendingEnabled: false }, resumeSending: { sendingEnabled: true } };
    if (req.body.confirmation !== 'APPLY TO SELECTED WORKSPACES') fail('Explicit bulk operation confirmation is required.');
    const ids = req.body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(value => typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) || new Set(ids.map(value => value.toLowerCase())).size !== ids.length || !Object.hasOwn(actions, req.body.action)) fail('Choose 1 to 50 distinct workspaces and a supported action.');
    if (await Workspace.countDocuments({ _id: { $in: ids }, deletedAt: null }) !== ids.length) fail('One or more selected workspaces no longer exist.', 404);
    const result = await Workspace.updateMany({ _id: { $in: ids }, deletedAt: null }, { $set: actions[req.body.action] });
    req.auditDetails = { workspaceIds: ids, operation: req.body.action, changed: result.modifiedCount };
    res.json({ matched: result.matchedCount, changed: result.modifiedCount });
  }));
  router.get('/monitoring', wrap(async (req, res) => {
    const filter = {};
    if (req.query.workspace) filter.workspace = new mongoose.Types.ObjectId(validId(req.query.workspace));
    if (req.query.status) { if (!['queued', 'unknown', 'sent', 'delivered', 'read', 'failed'].includes(req.query.status)) fail('Choose a valid message status.'); filter.status = req.query.status; }
    const page = pageOf(req);
    const [items, total, statuses] = await Promise.all([
      Message.find(filter).select('workspace conversation direction type status body providerMessageId error providerEventAt createdAt').populate('workspace', 'name').sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50).lean(),
      Message.countDocuments(filter), Message.aggregate([{ $match: filter }, { $group: { _id: { direction: '$direction', status: '$status' }, count: { $sum: 1 } } }]),
    ]);
    res.json({ items, total, statuses, page });
  }));
  router.get('/exports/:resource', wrap(async (req, res) => {
    const source = req.params.resource;
    if (source !== 'users' && source !== 'workspaces' && !Object.hasOwn(resources, source)) fail('Unknown export resource.', 404);
    const filter = {};
    let Model, fields;
    if (source === 'users' || source === 'workspaces') filter.deletedAt = null;
    if (source === 'users') { Model = User; fields = ['_id', 'name', 'email', 'role', 'company', 'isActive', 'lastLoginAt', 'createdAt']; }
    else if (source === 'workspaces') { Model = Workspace; fields = ['_id', 'name', 'slug', 'owner', 'isActive', 'plan', 'subscriptionEndsAt', 'sendingEnabled', 'createdAt']; }
    else { Model = resources[source][0]; filter.workspace = (await workspaceFor(req))._id; fields = ['_id', 'workspace', ...resources[source][1], ...['status', 'createdAt', 'updatedAt', 'providerMessageId', 'direction', 'fileName', ...(source === 'messages' ? ['body', 'error', 'providerEventAt'] : [])].filter(key => Model.schema.path(key))]; fields = [...new Set(fields)]; }
    if (req.query.after) filter._id = { $gt: validId(req.query.after) };
    const items = await Model.find(filter).select(fields.join(' ')).sort({ _id: 1 }).limit(1001).lean();
    const more = items.length > 1000; const rows = items.slice(0, 1000);
    req.auditRead = true; req.auditDetails = { resource: source, rowCount: rows.length };
    const value = item => item == null ? '' : item instanceof Date ? item.toISOString() : typeof item === 'object' && !item.toHexString ? JSON.stringify(item) : String(item);
    res.json({ fileName: `waba-${source}.csv`, content: csv([...(req.query.after ? [] : [fields]), ...rows.map(item => fields.map(key => value(item[key])))]), next: more ? String(rows.at(-1)._id) : null });
  }));
  router.get('/announcements', wrap(async (_req, res) => res.json({ items: await PlatformAnnouncement.find().sort({ createdAt: -1 }).lean() })));
  const announcementPayload = async body => {
    const payload = pick(body, ['title', 'message', 'level', 'audience', 'workspaces', 'isActive', 'startsAt', 'endsAt']);
    if (payload.isActive !== undefined && typeof payload.isActive !== 'boolean') fail('Announcement status must be true or false.');
    for (const key of ['startsAt', 'endsAt']) if (payload[key] && Number.isNaN(new Date(payload[key]).getTime())) fail('Invalid announcement date.');
    if (payload.startsAt && payload.endsAt && new Date(payload.endsAt) <= new Date(payload.startsAt)) fail('Announcement end must be later than its start.');
    if (payload.audience === 'Selected workspaces') {
      if (!Array.isArray(payload.workspaces) || !payload.workspaces.length || payload.workspaces.length > 1000 || payload.workspaces.some(value => typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) || new Set(payload.workspaces).size !== payload.workspaces.length) fail('Choose distinct target workspaces.');
      if (await Workspace.countDocuments({ _id: { $in: payload.workspaces }, deletedAt: null }) !== payload.workspaces.length) fail('Target workspace not found.');
    } else payload.workspaces = [];
    return payload;
  };
  router.post('/announcements', wrap(async (req, res) => res.status(201).json({ item: await PlatformAnnouncement.create({ ...await announcementPayload(req.body), createdBy: req.user._id }) })));
  router.patch('/announcements/:id', wrap(async (req, res) => {
    const item = await PlatformAnnouncement.findById(validId(req.params.id)); if (!item) fail('Announcement not found.', 404);
    Object.assign(item, await announcementPayload({ ...item.toObject(), workspaces: item.workspaces.map(String), ...req.body })); await item.save(); res.json({ item });
  }));
  router.delete('/announcements/:id', wrap(async (req, res) => {
    if (!await PlatformAnnouncement.findByIdAndDelete(validId(req.params.id))) fail('Announcement not found.', 404);
    res.json({ message: 'Announcement removed.' });
  }));
  return router;
}
