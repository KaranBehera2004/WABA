import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Workspace from '../models/Workspace.js';
import { PlatformPlan } from '../models/Platform.js';
import { createWithCapacity, effectiveLimits } from './capacity.js';

test('workspace capacity overrides inherit plans and can explicitly become unlimited', async () => {
  const original = PlatformPlan.findById;
  PlatformPlan.findById = () => ({ lean: async () => ({ limits: { contacts: 10, members: 4 } }) });
  try {
    const limits = await effectiveLimits({ plan: 'test-plan', limits: { contacts: null, templates: 0 } });
    assert.equal(limits.contacts, null); assert.equal(limits.members, 4); assert.equal(limits.templates, 0); assert.equal(limits.calls, null);
  } finally { PlatformPlan.findById = original; }
});
test('ordinary record creation checks capacity inside the serialized transaction; superadmins bypass quotas', async () => {
  const originalSession = mongoose.startSession, originalUpdate = Workspace.findOneAndUpdate;
  let created = 0, ended = 0, used = 1, lockTaken = 0, charged = 0;
  const session = { withTransaction: async fn => fn(), endSession: async () => { ended++; } };
  mongoose.startSession = async () => session;
  Workspace.findOneAndUpdate = async (_filter, update, options) => { assert.equal(update.$inc.capacityVersion, 1); assert.equal(options.session, session); lockTaken++; return { _id: 'workspace', limits: { contacts: 1 } }; };
  const Model = { countDocuments: () => ({ session: async passed => { assert.equal(passed, session); return used; } }), create: async (payload, options) => { created++; if (Array.isArray(payload)) { assert.equal(options.session, session); return payload; } return payload; } };
  const req = { user: { role: 'agent' }, workspace: { _id: 'workspace' } };
  const charge = async event => { assert.equal(event.session, session); assert.equal(event.activity, 'contacts'); assert.equal(event.workspace, 'workspace'); assert.ok(mongoose.isValidObjectId(event.recordId)); charged++; };
  try {
    await assert.rejects(() => createWithCapacity(req, 'contacts', Model, { name: 'Blocked' }, charge), error => error.status === 403);
    assert.equal(created, 0); assert.equal(ended, 1); assert.equal(charged, 0);
    used = 0; assert.equal((await createWithCapacity(req, 'contacts', Model, { name: 'Allowed' }, charge)).name, 'Allowed');
    assert.equal(lockTaken, 2); assert.equal(created, 1);
    req.user.role = 'superadmin'; await createWithCapacity(req, 'contacts', Model, { name: 'Administrator override' }, charge);
    assert.equal(lockTaken, 3); assert.equal(created, 2); assert.equal(charged, 2);
  } finally { mongoose.startSession = originalSession; Workspace.findOneAndUpdate = originalUpdate; }
});
