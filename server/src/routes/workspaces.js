import { Router } from 'express';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireWorkspace } from '../middleware/workspace.js';
import { createWorkspaceForUser } from '../services/workspace.js';
import { platformSettings } from '../services/platform.js';
import { PlatformAnnouncement, PlatformSettings } from '../models/Platform.js';
import { SmartpingError } from '../services/smartping.js';
import { effectiveLimits } from '../services/capacity.js';
import { membershipCapacityFilter, WORKSPACE_ROLES, permissionsFor } from '../services/accessControl.js';

import { assertCreationRole, assertActorPermission, visibleMembers } from '../services/businessAccess.js';
const router = Router();
router.use(requireAuth);
router.use(async (req, res, next) => {
  try {
    req.platformSettings = await platformSettings();
    if (req.user.role !== 'superadmin' && req.platformSettings.memberAccessEnabled === false) return res.status(503).json({ message: 'Workspace access has been paused by the platform administrator.' });
    next();
  } catch (error) { next(error); }
});

router.get('/', async (req, res, next) => {
  try { res.json({ workspaces: await Workspace.find({ deletedAt: null, 'members.user': req.user._id }).select('name slug settings whatsapp createdAt') }); }
  catch (error) { next(error); }
});
router.post('/', async (req, res, next) => {
  try {
    if (req.user.role !== 'superadmin' && req.user.role !== 'owner') throw new SmartpingError('Only a business owner or Super Admin can create a workspace.', 403);
    const settings = req.platformSettings;
    if (req.user.role !== 'superadmin' && (settings.maintenanceEnabled || settings.workspaceCreationEnabled === false)) return res.status(403).json({ message: 'Workspace creation is disabled by the platform administrator.' });
    const workspace = await createWorkspaceForUser(req.user, req.body.name, { settings, bypassLimit: req.user.role === 'superadmin' }); res.status(201).json({ workspace });
  }
  catch (error) { next(error); }
});
router.get('/current', requireWorkspace, async (req, res, next) => {
  try {
    const workspace = await Workspace.findById(req.workspace._id).populate('owner members.user', 'name email role company isActive');
    if (!workspace || workspace.deletedAt) throw new SmartpingError('Workspace not found.', 404);
    if (req.user.role !== 'superadmin' && (!req.enabledFeatures.includes('team') || !req.permissions.includes('team.read'))) workspace.members = [];
    if (req.user.role !== 'superadmin' && !req.permissions.includes('wallet.read')) workspace.customPlan = undefined;
    if (req.user.role !== 'superadmin' && ['agent','supervisor'].includes(req.membership.role) && !req.permissions.includes('team.manage')) {
      const visible = new Set(visibleMembers(req).map(member => String(member.user)));
      workspace.members = workspace.members.filter(member => visible.has(String(member.user?._id || member.user)));
    }
    res.json({ workspace, membershipRole: req.membership.role, customPermissions: Boolean(Array.isArray(req.membership.customPermissions) || req.workspace.permissionRules?.some(rule => rule.role === req.membership.role)), enabledFeatures: req.enabledFeatures, permissions: req.permissions });
  } catch (error) { next(error); }
});
router.patch('/current', requireWorkspace, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const allowed = ['name', 'settings'];
    allowed.forEach(key => { if (req.body[key] !== undefined) req.workspace[key] = req.body[key]; });
    await req.workspace.save(); res.json({ workspace: req.workspace });
  } catch (error) { next(error); }
});
router.post('/current/invite', requireWorkspace, requireRole('owner', 'admin'), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const role = req.body.role ?? 'agent';
    if (!WORKSPACE_ROLES.includes(role)) return res.status(400).json({ message: 'Choose Business Admin, Agent or Supervisor for this business.' });
    const session = await mongoose.startSession(); let user;
    try { await session.withTransaction(async () => {
      await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $inc: { controlVersion: 1 } }, { upsert: true, session });
      user = await User.findOne({ email, deletedAt: null, isActive: true }).session(session);
      if (!user) throw new SmartpingError('No active registered account has that email.', 404);
      if (user.role === 'superadmin' && req.user.role !== 'superadmin') throw new SmartpingError('Platform accounts can only be linked by Super Admin.', 403);
      const workspace = await Workspace.findById(req.workspace._id).session(session);
      if (!workspace || workspace.deletedAt) throw new SmartpingError('Workspace not found.', 404);
      const actor = workspace.members.find(member => String(member.user) === String(req.user._id));
      assertActorPermission(workspace, actor, req.user.role, 'team.manage');
      assertCreationRole(workspace, role, req.user.role);
      const limits = await effectiveLimits(workspace, session);
      const filter = membershipCapacityFilter(workspace._id, user._id, role, limits, req.user.role === 'superadmin', req.user.role !== 'superadmin');
      const added = await Workspace.updateOne(filter, { $push: { members: { user: user._id, role, visibility: role === 'supervisor' ? 'teams' : 'assigned', joinedAt: new Date() } }, $inc: { capacityVersion: 1 } }, { session });
      if (!added.modifiedCount && !workspace.members.some(member => String(member.user) === String(user._id))) throw new SmartpingError(`Member capacity or the ${role} seat limit was reached, or this membership changed. Refresh and try again.`, 403);
    }); } finally { await session.endSession(); }
    res.json({ message: 'Team member added.', member: { user: user.toSafeObject(), role } });
  } catch (error) { next(error); }
});

router.get('/current/announcements', requireWorkspace, async (req, res, next) => {
  try {
    const now = new Date();
    const items = await PlatformAnnouncement.find({ isActive: true, $and: [
      { $or: [{ audience: 'All workspaces' }, { workspaces: req.workspace._id }] },
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
    ] }).select('title message level').sort({ createdAt: -1 }).limit(10).lean();
    res.json({ items });
  } catch (error) { next(error); }
});

export default router;
