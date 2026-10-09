import mongoose from 'mongoose';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { platformSettings } from './platform.js';
import { createWorkspaceForUser } from './workspace.js';
import { validateWorkspaceConfiguration, validateWorkspaceOwner } from './workspaceConfig.js';
import { SmartpingError } from './smartping.js';

export function workspaceConflict(error) {
  if (error?.code !== 11000) return error;
  const slug = Object.hasOwn(error.keyPattern || error.keyValue || {}, 'slug');
  return new SmartpingError(slug ? 'That business identifier is already in use.' : 'An account with that email already exists. Select the existing owner or use another email.', 409);
}

// Restricted to the authenticated superadmin route. New account creation and
// workspace/default membership provisioning share one transaction and commit
// together; neither an orphan login nor an ownerless business can be produced.
export async function provisionSuperadminWorkspace(body) {
  const { name, ...initialConfiguration } = validateWorkspaceConfiguration(body);
  const settings = await platformSettings();
  const account = validateWorkspaceOwner(body, settings);
  if (initialConfiguration.slug && await Workspace.exists({ slug: initialConfiguration.slug })) throw new SmartpingError('That business identifier is already in use.', 409);
  if (account.owner) {
    const owner = await User.findById(account.owner);
    if (!owner || owner.deletedAt || !owner.isActive) throw new SmartpingError('Choose an active registered owner.', 400);
    try {
      const item = await createWorkspaceForUser(owner, name, { settings, bypassLimit: true, preserveDefault: true, initialConfiguration });
      return { item };
    } catch (error) { throw workspaceConflict(error); }
  }
  if (await User.exists({ email: account.newOwner.email })) throw new SmartpingError('An account with that email already exists. Select the existing owner or use another email.', 409);
  const session = await mongoose.startSession();
  let item, owner;
  try {
    await session.withTransaction(async () => {
      // Construct a fresh document on every driver retry: a prior aborted
      // attempt must not be reused with an already-hashed password.
      [owner] = await User.create([{ ...account.newOwner, role: 'owner', company: name, isActive: true }], { session });
      item = await createWorkspaceForUser(owner, name, { session, settings, bypassLimit: true, initialConfiguration });
    });
  } catch (error) { throw workspaceConflict(error); }
  finally { await session.endSession(); }
  return { item, owner: owner.toSafeObject() };
}
