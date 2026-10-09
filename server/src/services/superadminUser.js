import mongoose from 'mongoose';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { platformSettings } from './platform.js';
import { passwordPolicyError } from './platformConfig.js';
import { effectiveLimits } from './capacity.js';
import { membershipCapacityFilter, WORKSPACE_ROLES } from './accessControl.js';
import { SmartpingError } from './smartping.js';

const fail = (message, status = 400) => { throw new SmartpingError(message, status); };
const string = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.trim().length > max || required && !value.trim()) fail(`Enter a valid ${label}, up to ${max} characters.`);
  return value.trim();
};

export function validateSuperadminAccount(body, settings) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Provide account details as an object.');
  const payload = { name: string(body.name, 'account name', 80), email: string(body.email, 'email address', 200).toLowerCase(), password: body.password, role: body.role };
  if (!['superadmin', 'owner', 'admin', 'agent', 'supervisor'].includes(payload.role)) fail('Choose a valid account role.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) fail('Enter a valid email address.');
  const passwordError = passwordPolicyError(payload.password, settings, 10); if (passwordError) fail(passwordError);
  const linked = body.workspaceId !== undefined || body.workspaceRole !== undefined;
  if (!linked) {
    if (body.company !== undefined) payload.company = string(body.company, 'company', 120, false);
    return { payload };
  }
  if (typeof body.workspaceId !== 'string' || !/^[a-f0-9]{24}$/i.test(body.workspaceId)) fail('Choose a valid existing business.');
  if (!WORKSPACE_ROLES.includes(body.workspaceRole)) fail('Choose Admin, Agent or Supervisor access for this business. Workspace ownership is assigned through business setup.');
  const expectedRole = body.workspaceRole;
  if (payload.role !== expectedRole) fail('The account role must match business access: admin, agent or supervisor. Owners and superadmins cannot be assigned through this form.');
  return { payload, workspaceId: body.workspaceId, workspaceRole: body.workspaceRole };
}

const duplicate = error => error?.code === 11000 ? new SmartpingError('An account with that email already exists.', 409) : error;

export async function createSuperadminAccount(body) {
  const { payload, workspaceId, workspaceRole } = validateSuperadminAccount(body, await platformSettings());
  if (await User.exists({ email: payload.email })) fail('An account with that email already exists.', 409);
  // Compatibility for platform accounts and the previous unlinked endpoint.
  // A supplied company is never accepted as membership or workspace access.
  if (!workspaceId) {
    try { return { item: (await User.create(payload)).toSafeObject() }; }
    catch (error) { throw duplicate(error); }
  }
  const session = await mongoose.startSession();
  let user;
  try {
    await session.withTransaction(async () => {
      // Serialize account onboarding with all other capacity-checked creates.
      // Each retry reads the latest business name and capacity configuration.
      const workspace = await Workspace.findOneAndUpdate({ _id: workspaceId, deletedAt: null }, { $inc: { capacityVersion: 1 } }, { new: true, session });
      if (!workspace) fail('Workspace not found.', 404);
      const limits = await effectiveLimits(workspace, session);
      // Fresh User.create on every retry avoids reusing an aborted document
      // whose password hook has already run.
      [user] = await User.create([{ ...payload, company: workspace.name, defaultWorkspace: workspace._id, isActive: true }], { session });
      const filter = membershipCapacityFilter(workspace._id, user._id, workspaceRole, limits);
      const added = await Workspace.updateOne(filter, { $push: { members: { user: user._id, role: workspaceRole, joinedAt: new Date() } } }, { session });
      if (!added.modifiedCount) fail(`This business has reached its member capacity or ${workspaceRole} seat limit. Increase its capacity before adding another account.`, 403);
    });
  } catch (error) { throw duplicate(error); }
  finally { await session.endSession(); }
  return { item: user.toSafeObject() };
}
