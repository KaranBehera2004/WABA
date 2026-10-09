import Workspace from '../models/Workspace.js';
import mongoose from 'mongoose';
import User from '../models/User.js';
import { PlatformPlan } from '../models/Platform.js';
import { platformSettings } from './platform.js';
import { newWorkspaceDefaults } from './platformConfig.js';
import { SmartpingError } from './smartping.js';

export async function createWorkspaceForUser(user, requestedName, options = {}) {
  const settings = options.settings || await platformSettings();
  // Only the validated superadmin route supplies initialConfiguration.
  const initial = options.initialConfiguration || {};
  const previousDefault = user.defaultWorkspace;
  const name = String(requestedName || user.company || `${user.name}'s Workspace`).trim();
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
  const slug = initial.slug || `${base}-${new mongoose.Types.ObjectId().toString().slice(-12)}`;
  const provision = async session => {
    const owner = await User.updateOne({ _id: user._id, deletedAt: null, isActive: true }, { $inc: { workspaceProvisionVersion: 1 } }, { session });
    if (!owner.matchedCount) throw new SmartpingError('Choose an active registered owner.', 400);
    if (!options.bypassLimit && settings.workspaceLimitPerOwner !== null) {
      if (await Workspace.countDocuments({ owner: user._id, deletedAt: null }).session(session) >= settings.workspaceLimitPerOwner) throw new SmartpingError('This account has reached its workspace creation limit. Contact the platform administrator.', 403);
    }
    const plan = Object.hasOwn(initial, 'plan') ? initial.plan : settings.defaultPlan;
    const activePlan = plan ? await PlatformPlan.exists({ _id: plan, isActive: true }).session(session) : false;
    if (plan && !activePlan) throw new SmartpingError(Object.hasOwn(initial, 'plan') ? 'Choose an active plan.' : 'The default workspace plan is unavailable. Ask the platform administrator to choose an active plan.', 409);
    const { timezone, ...defaults } = newWorkspaceDefaults({ ...settings, defaultPlan: plan }, activePlan);
    const { settings: initialSettings, trialDays, ...overrides } = initial;
    if (trialDays !== undefined) overrides.subscriptionEndsAt = trialDays ? new Date(Date.now() + trialDays * 86400000) : null;
    const [workspace] = await Workspace.create([{ name, slug, ...defaults, ...overrides, owner: user._id, members: [{ user: user._id, role: 'owner' }], settings: { supportEmail: user.email, timezone, ...initialSettings } }], { session });
    // Use the pre-transaction value: the driver's retry must still persist a
    // first default if a previous, aborted attempt changed this document in memory.
    if (!options.preserveDefault || !previousDefault) { user.defaultWorkspace = workspace._id; await user.save({ validateBeforeSave: false, session }); }
    return workspace;
  };
  if (options.session) return provision(options.session);
  const session = await mongoose.startSession(); let workspace;
  try { await session.withTransaction(async () => { workspace = await provision(session); }); }
  catch (error) { user.defaultWorkspace = previousDefault; throw error; }
  finally { await session.endSession(); }
  return workspace;
}

export async function ensureUserWorkspace(user) {
  if (user.role === 'superadmin') return user.defaultWorkspace || null;
  if (user.defaultWorkspace) return user.defaultWorkspace;
  const existing = await Workspace.findOne({ deletedAt: null, 'members.user': user._id }).select('_id');
  if (existing) { user.defaultWorkspace = existing._id; await user.save({ validateBeforeSave: false }); return existing._id; }
  // Removed teammates must not silently receive a new owner workspace on login.
  if (user.role !== 'owner' || user.autoWorkspaceCreationBlocked || user.deletedAt) return null;
  const settings = await platformSettings();
  if (settings.maintenanceEnabled || settings.workspaceCreationEnabled === false || settings.workspaceLimitPerOwner === 0) return null;
  return (await createWorkspaceForUser(user))._id;
}
