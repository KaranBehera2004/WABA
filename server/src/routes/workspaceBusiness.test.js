import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import superadminRouter from './superadmin.js';
import workspaceRouter from './workspaces.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { AdminAudit, PlatformSettings } from '../models/Platform.js';
import { auditAdminChanges } from '../middleware/superadmin.js';

test('business onboarding creates a safe owner and configured workspace in one transaction', async t => {
  const rootId = '507f1f77bcf86cd799439011', existingId = '507f1f77bcf86cd799439012';
  const env = process.env.JWT_SECRET; process.env.JWT_SECRET = 'business-onboarding-test-only';
  const mocks = []; const mock = (target, key, fn) => { mocks.push([target, key, target[key]]); target[key] = fn; };
  const root = { _id: new mongoose.Types.ObjectId(rootId), role: 'superadmin', isActive: true, sessionVersion: 0 };
  const existing = { _id: new mongoose.Types.ObjectId(existingId), role: 'owner', isActive: true, email: 'existing@example.com', defaultWorkspace: 'old-default', save: async () => { throw new Error('Existing default must not be overwritten.'); } };
  let duplicateEmail = false, duplicateSlug = false, workspaceFailure = null, saveFailure = false, retry = false, createdOwners = 0, started = 0, ended = 0;
  const committed = { users: [], workspaces: [] }, audits = [];
  let settings = { defaultPlan: null, trialDays: 0 };
  const session = { staged: null, withTransaction: async fn => {
    session.staged = { users: [], workspaces: [] };
    if (retry) { await fn(); session.staged = { users: [], workspaces: [] }; }
    await fn(); committed.users.push(...session.staged.users); committed.workspaces.push(...session.staged.workspaces);
  }, endSession: async () => { ended++; } };
  mock(mongoose, 'startSession', async () => { started++; return session; });
  mock(User, 'findById', async id => String(id) === rootId ? root : String(id) === existingId ? existing : null);
  mock(User, 'exists', async () => duplicateEmail);
  mock(User, 'updateOne', async (filter, _update, options) => { assert.equal(options.session, session); assert.equal(filter.deletedAt, null); assert.equal(filter.isActive, true); return { matchedCount: 1, modifiedCount: 1 }; });
  mock(Workspace, 'exists', async () => duplicateSlug);
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => settings }));
  mock(AdminAudit, 'create', async record => { audits.push(record); return record; });
  mock(User, 'create', async (records, options) => {
    assert.equal(options.session, session); assert.equal(records[0].role, 'owner'); assert.equal(records[0].isActive, true);
    createdOwners++;
    const owner = new User(records[0]);
    // Execute the actual Mongoose password pre-save hook, without a DB write.
    await new Promise((resolve, reject) => User.schema.s.hooks.execPre('save', owner, [], error => error ? reject(error) : resolve()));
    assert.notEqual(owner.password, records[0].password); assert.equal(await bcrypt.compare(records[0].password, owner.password), true);
    owner.unmarkModified('password');
    owner.save = async saveOptions => { assert.equal(saveOptions.session, session); if (saveFailure) throw new Error('Simulated default save failure'); return owner; };
    session.staged.users.push(owner); return [owner];
  });
  mock(Workspace, 'create', async (records, options) => {
    assert.equal(options.session, session); if (workspaceFailure) throw workspaceFailure;
    const item = { ...records[0], _id: new mongoose.Types.ObjectId() }; session.staged.workspaces.push(item); return [item];
  });
  const app = express(); app.use(express.json()); app.use(auditAdminChanges); app.use('/api/superadmin', superadminRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = body => fetch(`http://127.0.0.1:${server.address().port}/api/superadmin/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: rootId, version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' })}` }, body: JSON.stringify(body) });
  const body = { name: 'New business', slug: 'new-business', email: ' CONTACT@EXAMPLE.COM ', phone: '+919876543210', newOwner: { name: 'First owner', email: 'OWNER@EXAMPLE.COM', password: 'LongPassword123', role: 'superadmin', isActive: false }, addonFeatures: ['campaigns'], seatLimits: { admin: 2, agent: 5 }, plan: null };
  try {
    await t.test('password is hashed once, owner privilege is fixed, and response/audit never contain credentials', async () => {
      const response = await request(body); assert.equal(response.status, 201); const text = await response.text(), result = JSON.parse(text);
      const owner = committed.users.at(-1), workspace = committed.workspaces.at(-1);
      assert.equal(owner.role, 'owner'); assert.equal(owner.company, body.name); assert.equal(owner.isActive, true);
      assert.equal(String(owner.defaultWorkspace), String(workspace._id)); assert.equal(String(workspace.owner), String(owner._id));
      assert.deepEqual(workspace.members, [{ user: owner._id, role: 'owner' }]);
      assert.equal(workspace.slug, 'new-business'); assert.equal(workspace.email, 'contact@example.com'); assert.equal(workspace.phone, body.phone);
      assert.deepEqual(workspace.seatLimits, body.seatLimits); assert.deepEqual(workspace.addonFeatures, ['campaigns']);
      assert.equal(result.owner.email, 'owner@example.com'); assert.equal(result.owner.workspaceId, result.item._id);
      assert.ok(!text.includes(body.newOwner.password)); assert.ok(!text.includes(owner.password)); assert.equal(result.owner.password, undefined);
      assert.ok(!JSON.stringify(audits).includes(body.newOwner.password)); assert.ok(!JSON.stringify(audits).includes(owner.password));
      assert.equal(started, ended);
    });
    await t.test('existing owner compatibility preserves previous account and default workspace', async () => {
      const ownerCount = createdOwners;
      const response = await request({ name: 'Legacy business', owner: existingId, email: '', phone: '', plan: null }); assert.equal(response.status, 201);
      assert.equal(createdOwners, ownerCount); assert.equal(existing.defaultWorkspace, 'old-default');
      assert.match(committed.workspaces.at(-1).slug, /^legacy-business-[a-f0-9]{12}$/); assert.equal(started, ended);
    });
    await t.test('invalid and conflicting owner modes fail before opening a transaction', async () => {
      const before = started;
      for (const bad of [{ ...body, owner: existingId }, { ...body, newOwner: undefined }, { ...body, newOwner: { ...body.newOwner, password: 'notstrong123' } }, { ...body, slug: 'bad_slug' }, { ...body, seatLimits: { owner: 2 } }]) assert.equal((await request(bad)).status, 400);
      settings.passwordMinLength = 20; assert.equal((await request(body)).status, 400); settings.passwordMinLength = 8;
      assert.equal(started, before);
    });
    await t.test('duplicate owner email and business identifier produce conflicts without writes', async () => {
      const before = started;
      duplicateEmail = true; assert.equal((await request(body)).status, 409); duplicateEmail = false;
      duplicateSlug = true; assert.equal((await request(body)).status, 409); duplicateSlug = false;
      assert.equal(started, before);
    });
    await t.test('late duplicate and save failures roll back both staged resources and close the session', async () => {
      const before = [committed.users.length, committed.workspaces.length];
      workspaceFailure = Object.assign(new Error('Duplicate slug'), { code: 11000, keyPattern: { slug: 1 } }); assert.equal((await request(body)).status, 409);
      workspaceFailure = Object.assign(new Error('Concurrent email collision'), { code: 11000, keyPattern: { email: 1 } }); assert.equal((await request(body)).status, 409);
      workspaceFailure = new Error('Simulated workspace failure'); assert.equal((await request(body)).status, 500); workspaceFailure = null;
      saveFailure = true; assert.equal((await request(body)).status, 500); saveFailure = false;
      assert.deepEqual([committed.users.length, committed.workspaces.length], before); assert.equal(started, ended);
    });
    await t.test('transaction retry creates fresh owner documents and commits one complete business', async () => {
      const before = [committed.users.length, committed.workspaces.length], count = createdOwners; retry = true;
      assert.equal((await request(body)).status, 201); retry = false;
      assert.equal(createdOwners, count + 2); assert.deepEqual([committed.users.length, committed.workspaces.length], before.map(value => value + 1));
      assert.equal(String(committed.users.at(-1).defaultWorkspace), String(committed.workspaces.at(-1)._id)); assert.equal(started, ended);
    });
    await t.test('later business edits validate new controls and preserve unspecified role ceilings', async () => {
      let saves = 0, conflict = false;
      const item = { _id: new mongoose.Types.ObjectId(), plan: null, seatLimits: { admin: 2, agent: 5, viewer: null }, save: async () => { if (conflict) throw Object.assign(new Error('Duplicate slug'), { code: 11000, keyPattern: { slug: 1 } }); saves++; } };
      mock(Workspace, 'findById', () => ({ select: async () => item }));
      const patch = updates => fetch(`http://127.0.0.1:${server.address().port}/api/superadmin/workspaces/${item._id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: rootId, version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' })}` }, body: JSON.stringify(updates) });
      assert.equal((await patch({ seatLimits: { agent: 0 }, addonFeatures: ['analytics'], email: ' BUSINESS@EXAMPLE.COM ', phone: ' +919876543210 ', slug: 'updated-business' })).status, 200);
      assert.deepEqual(item.seatLimits, { admin: 2, agent: 0, viewer: null }); assert.deepEqual(item.addonFeatures, ['analytics']); assert.equal(item.email, 'business@example.com'); assert.equal(item.phone, '+919876543210');
      for (const bad of [{ seatLimits: { viewer: 0 } }, { seatLimits: { owner: 10 } }, { addonFeatures: ['unknown'] }, { email: 'bad' }, { slug: 'bad_slug' }]) assert.equal((await patch(bad)).status, 400);
      assert.equal(saves, 1); conflict = true; assert.equal((await patch({ slug: 'taken-business' })).status, 409); assert.equal(saves, 1);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [target, key, original] of mocks.reverse()) target[key] = original;
    if (env === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = env;
  }
});

const readPath = (target, path) => path.split('.').reduce((value, key) => value?.[key], target);
function evaluate(expression, workspace, variables = {}) {
  if (Array.isArray(expression)) return expression.map(item => evaluate(item, workspace, variables));
  if (typeof expression === 'string' && expression.startsWith('$$')) { const [variable, ...path] = expression.slice(2).split('.'); return readPath(variables[variable], path.join('.')); }
  if (typeof expression === 'string' && expression.startsWith('$')) return readPath(workspace, expression.slice(1));
  if (expression === null || typeof expression !== 'object') return expression;
  const [operator, value] = Object.entries(expression)[0];
  const values = () => value.map(item => evaluate(item, workspace, variables));
  if (operator === '$and') return values().every(Boolean);
  if (operator === '$or') return values().some(Boolean);
  if (operator === '$eq') { const [a, b] = values(); return a === b; }
  if (operator === '$in') { const [a, b] = values(); return b.includes(a); }
  if (operator === '$lt') { const [a, b] = values(); return a < b; }
  if (operator === '$ifNull') { const [a, b] = values(); return a ?? b; }
  if (operator === '$size') return evaluate(value, workspace, variables).length;
  if (operator === '$filter') return evaluate(value.input, workspace, variables).filter(member => evaluate(value.cond, workspace, { ...variables, [value.as]: member }));
  throw new Error(`Unexpected quota expression ${operator}`);
}

test('real invite route checks role seats and total quota atomically within the selected tenant', async t => {
  const ownerId = new mongoose.Types.ObjectId(), firstId = new mongoose.Types.ObjectId(), secondId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId(), otherId = new mongoose.Types.ObjectId();
  const env = process.env.JWT_SECRET; process.env.JWT_SECRET = 'role-seat-test-only';
  const mocks = []; const mock = (target, key, fn) => { mocks.push([target, key, target[key]]); target[key] = fn; };
  const owner = { _id: ownerId, role: 'owner', isActive: true, sessionVersion: 0, defaultWorkspace: workspaceId };
  const users = [{ _id: firstId, email: 'first@example.com', toSafeObject() { return { id: this._id }; } }, { _id: secondId, email: 'second@example.com', toSafeObject() { return { id: this._id }; } }];
  const workspace = { _id: workspaceId, isActive: true, seatLimits: { admin: 0, agent: 1, viewer: null }, limits: { members: 5 }, members: [{ user: ownerId, role: 'owner' }] };
  const other = { ...workspace, _id: otherId, members: [{ user: ownerId, role: 'owner' }] };
  const workspaces = new Map([[String(workspaceId), workspace], [String(otherId), other]]);
  mock(User, 'findById', async () => owner);
  mock(User, 'findOne', filter => ({ session: async () => { assert.equal(filter.deletedAt, null); assert.equal(filter.isActive, true); return users.find(user => user.email === filter.email); } }));
  mock(mongoose, 'startSession', async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }));
  mock(PlatformSettings, 'findOneAndUpdate', async () => ({}));
  mock(Workspace, 'findById', id => ({ session: async () => workspaces.get(String(id)) }));
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => ({}) }));
  mock(Workspace, 'findOne', async filter => {
    const item = workspaces.get(String(filter._id));
    if (!item || filter['members.user'] && !item.members.some(member => member.user.equals(filter['members.user']))) return null;
    return { ...item, members: item.members.map(member => ({ ...member })) };
  });
  mock(Workspace, 'updateOne', async (filter, update) => {
    const item = workspaces.get(String(filter._id));
    if (!item || item.members.some(member => member.user.equals(filter['members.user'].$ne)) || filter.$expr && !evaluate(filter.$expr, item)) return { modifiedCount: 0 };
    item.members.push(update.$push.members); return { modifiedCount: 1 };
  });
  const app = express(); app.use(express.json()); app.use('/api/workspaces', workspaceRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = (email, role, target = workspaceId) => fetch(`http://127.0.0.1:${server.address().port}/api/workspaces/current/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': String(target), Authorization: `Bearer ${jwt.sign({ sub: String(ownerId), version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' })}` }, body: JSON.stringify({ email, role }) });
  const reset = () => { workspace.members = [{ user: ownerId, role: 'owner' }]; other.members = [{ user: ownerId, role: 'owner' }]; };
  try {
    await t.test('retired and invalid role requests never silently become Agent memberships', async () => {
      for (const role of ['viewer','owner','superadmin','invalid']) assert.equal((await request('first@example.com', role)).status, 400);
      assert.equal(workspace.members.length, 1);
    });
    await t.test('zero role seats reject invitations without consuming total seats', async () => {
      assert.equal((await request('first@example.com', 'admin')).status, 403); assert.equal(workspace.members.length, 1);
    });
    await t.test('concurrent invitations cannot both claim the last role seat', async () => {
      const results = await Promise.all([request('first@example.com', 'agent'), request('second@example.com', 'agent')]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 403]); assert.equal(workspace.members.filter(member => member.role === 'agent').length, 1);
    });
    await t.test('the same role capacity is independent across workspaces', async () => {
      reset(); const results = await Promise.all([request('first@example.com', 'agent'), request('first@example.com', 'agent', otherId)]);
      assert.deepEqual(results.map(result => result.status), [200, 200]); assert.equal(workspace.members.length, 2); assert.equal(other.members.length, 2);
    });
    await t.test('unlimited roles still obey the total-member cap including the owner', async () => {
      reset(); workspace.limits.members = 2; workspace.seatLimits.agent = null;
      assert.equal((await request('first@example.com', 'agent')).status, 200); assert.equal((await request('second@example.com', 'agent')).status, 403); assert.equal(workspace.members.length, 2);
    });
    await t.test('root-only administrative invitations can bypass negotiated ceilings', async () => {
      owner.role = 'superadmin'; workspace.limits.members = 0;
      assert.equal((await request('second@example.com', 'admin')).status, 200); assert.equal(workspace.members.at(-1).role, 'admin');
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [target, key, original] of mocks.reverse()) target[key] = original;
    if (env === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = env;
  }
});
