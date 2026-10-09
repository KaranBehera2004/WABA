import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import superadminRouter from './superadmin.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { AdminAudit, PlatformPlan, PlatformSettings } from '../models/Platform.js';
import { auditAdminChanges } from '../middleware/superadmin.js';

const readPath = (target, path) => path.split('.').reduce((value, key) => value?.[key], target);
function evaluate(expression, record, variables = {}) {
  if (Array.isArray(expression)) return expression.map(item => evaluate(item, record, variables));
  if (typeof expression === 'string' && expression.startsWith('$$')) { const [key, ...path] = expression.slice(2).split('.'); return readPath(variables[key], path.join('.')); }
  if (typeof expression === 'string' && expression.startsWith('$')) return readPath(record, expression.slice(1));
  if (expression === null || typeof expression !== 'object') return expression;
  const [operator, value] = Object.entries(expression)[0]; const values = () => value.map(item => evaluate(item, record, variables));
  if (operator === '$and') return values().every(Boolean);
  if (operator === '$or') return values().some(Boolean);
  if (operator === '$eq') { const [a, b] = values(); return a === b; }
  if (operator === '$lt') { const [a, b] = values(); return a < b; }
  if (operator === '$ifNull') { const [a, b] = values(); return a ?? b; }
  if (operator === '$size') return evaluate(value, record, variables).length;
  if (operator === '$filter') return evaluate(value.input, record, variables).filter(member => evaluate(value.cond, record, { ...variables, [value.as]: member }));
  throw new Error(`Unexpected quota expression ${operator}`);
}

test('superadmin account creation atomically joins the selected business with safe roles and quotas', async t => {
  const rootId = '507f1f77bcf86cd799439011', workspaceId = '507f1f77bcf86cd799439012', otherId = '507f1f77bcf86cd799439013';
  const previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'superadmin-account-business-test-only';
  const originals = []; const mock = (target, key, fn) => { originals.push([target, key, target[key]]); target[key] = fn; };
  const root = { _id: new mongoose.Types.ObjectId(rootId), role: 'superadmin', isActive: true, sessionVersion: 0 };
  const newWorkspace = (id, name) => ({ _id: id, name, seatLimits: { admin: 2, agent: 3, viewer: null }, limits: { members: 10 }, members: [{ user: rootId, role: 'owner' }], capacityVersion: 0 });
  const storedWorkspaces = new Map([[workspaceId, newWorkspace(workspaceId, 'Selected business')], [otherId, newWorkspace(otherId, 'Other business')]]);
  const users = [], audits = [], payloads = [];
  let sessionsStarted = 0, sessionsEnded = 0, lockCalls = 0, duplicateEarly = false, duplicateLate = false, membershipFails = false, retry = false;
  let settings = { passwordMinLength: 8 }, transactionTail = Promise.resolve();
  mock(User, 'findById', async () => root);
  mock(User, 'exists', async filter => duplicateEarly || users.some(user => user.email === filter.email));
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => settings }));
  mock(PlatformPlan, 'findById', () => ({ session: () => ({ lean: async () => ({ limits: { members: 2 } }) }) }));
  mock(AdminAudit, 'create', async record => { audits.push(record); return record; });
  mock(mongoose, 'startSession', async () => {
    sessionsStarted++;
    const session = { stagedUsers: [], stagedWorkspaces: new Map(), withTransaction: async callback => {
      // Mock Mongo's transaction serialization; fixtures are private to each
      // attempt and become visible only after a successful commit.
      const previous = transactionTail; let unlock; transactionTail = new Promise(resolve => { unlock = resolve; });
      await previous;
      try {
        if (retry) { await callback(); session.stagedUsers = []; session.stagedWorkspaces.clear(); }
        await callback(); users.push(...session.stagedUsers);
        for (const [id, record] of session.stagedWorkspaces) storedWorkspaces.set(id, record);
      } finally { unlock(); }
    }, endSession: async () => { sessionsEnded++; } };
    return session;
  });
  mock(Workspace, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(update.$inc.capacityVersion, 1); assert.equal(options.new, true); assert.ok(options.session); lockCalls++;
    const stored = storedWorkspaces.get(String(filter._id)); if (!stored) return null;
    const record = { ...stored, seatLimits: { ...stored.seatLimits }, limits: { ...stored.limits }, members: stored.members.map(member => ({ ...member })), capacityVersion: stored.capacityVersion + 1 };
    options.session.stagedWorkspaces.set(String(filter._id), record); return record;
  });
  mock(User, 'create', async (records, options) => {
    if (duplicateLate) throw Object.assign(new Error('Duplicate email'), { code: 11000, keyPattern: { email: 1 } });
    const values = Array.isArray(records) ? records[0] : records; payloads.push(values);
    const user = new User(values);
    await new Promise((resolve, reject) => User.schema.s.hooks.execPre('save', user, [], error => error ? reject(error) : resolve()));
    assert.equal(await bcrypt.compare(values.password, user.password), true); assert.notEqual(user.password, values.password); user.unmarkModified('password');
    if (options?.session) { assert.ok(Array.isArray(records)); options.session.stagedUsers.push(user); return [user]; }
    users.push(user); return user;
  });
  mock(Workspace, 'updateOne', async (filter, update, options) => {
    assert.ok(options.session); assert.ok(filter.$expr); const record = options.session.stagedWorkspaces.get(String(filter._id));
    if (membershipFails) throw new Error('Simulated membership write failure');
    if (!record || record.members.some(member => String(member.user) === String(filter['members.user'].$ne)) || !evaluate(filter.$expr, record)) return { modifiedCount: 0 };
    record.members.push(update.$push.members); return { modifiedCount: 1 };
  });
  const app = express(); app.use(express.json()); app.use(auditAdminChanges); app.use('/api/superadmin', superadminRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = (body, version = 0) => fetch(`http://127.0.0.1:${server.address().port}/api/superadmin/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: rootId, version }, process.env.JWT_SECRET, { issuer: 'waba-api' })}` }, body: JSON.stringify(body) });
  const details = email => ({ name: 'Team member', email, password: 'LongPassword123', role: 'agent', workspaceId, workspaceRole: 'agent' });
  const reset = () => { storedWorkspaces.set(workspaceId, newWorkspace(workspaceId, 'Selected business')); storedWorkspaces.set(otherId, newWorkspace(otherId, 'Other business')); };
  try {
    await t.test('company/default workspace/membership all come from the selected business, not arbitrary text', async () => {
      const body = { ...details('NEW@EXAMPLE.COM'), company: 'Forged business', isActive: false, defaultWorkspace: otherId, sessionVersion: 99 };
      const response = await request(body); assert.equal(response.status, 201); const text = await response.text(), result = JSON.parse(text), user = users.at(-1);
      assert.equal(result.item.email, 'new@example.com'); assert.equal(result.item.company, 'Selected business'); assert.equal(result.item.workspaceId, workspaceId);
      assert.equal(user.isActive, true); assert.equal(user.sessionVersion, 0); assert.equal(String(user.defaultWorkspace), workspaceId);
      assert.equal(storedWorkspaces.get(workspaceId).members.at(-1).role, 'agent'); assert.equal(String(storedWorkspaces.get(workspaceId).members.at(-1).user), String(user._id));
      assert.equal(storedWorkspaces.get(otherId).members.length, 1); assert.equal(storedWorkspaces.get(workspaceId).capacityVersion, 1);
      assert.ok(!text.includes(body.password)); assert.ok(!text.includes(user.password)); assert.ok(!JSON.stringify(audits).includes(body.password)); assert.equal(sessionsStarted, sessionsEnded);
    });
    await t.test('Admin accounts persist while Viewer assignment is rejected before account creation', async () => {
      reset();
      assert.equal((await request({ ...details('admin@example.com'), role: 'admin', workspaceRole: 'admin' })).status, 201);
      assert.equal(users.at(-1).role, 'admin'); assert.equal(storedWorkspaces.get(workspaceId).members.at(-1).role, 'admin');
      const counts = [users.length, storedWorkspaces.get(workspaceId).members.length];
      assert.equal((await request({ ...details('viewer@example.com'), workspaceRole: 'viewer' })).status, 400);
      assert.deepEqual([users.length, storedWorkspaces.get(workspaceId).members.length], counts);
    });
    await t.test('missing businesses and invalid/escalated role combinations leave no account or membership behind', async () => {
      const before = users.length;
      assert.equal((await request({ ...details('missing@example.com'), workspaceId: '507f1f77bcf86cd799439099' })).status, 404);
      const started = sessionsStarted;
      for (const change of [{ workspaceId: 'bad' }, { workspaceRole: 'owner' }, { role: 'owner' }, { role: 'superadmin' }, { workspaceRole: 'admin' }, { workspaceRole: undefined }]) assert.equal((await request({ ...details('invalid@example.com'), ...change })).status, 400);
      assert.equal(sessionsStarted, started); assert.equal(users.length, before); assert.equal(sessionsStarted, sessionsEnded);
    });
    await t.test('early and concurrent duplicate emails return conflicts and roll back capacity changes', async () => {
      reset(); const before = users.length;
      duplicateEarly = true; const started = sessionsStarted; assert.equal((await request(details('taken@example.com'))).status, 409); duplicateEarly = false; assert.equal(sessionsStarted, started);
      duplicateLate = true; assert.equal((await request(details('late@example.com'))).status, 409); duplicateLate = false;
      assert.equal(users.length, before); assert.equal(storedWorkspaces.get(workspaceId).members.length, 1); assert.equal(storedWorkspaces.get(workspaceId).capacityVersion, 0); assert.equal(sessionsStarted, sessionsEnded);
    });
    await t.test('membership failure aborts the previously hashed user and releases the transaction', async () => {
      reset(); const before = users.length; membershipFails = true;
      assert.equal((await request(details('failed@example.com'))).status, 500); membershipFails = false;
      assert.equal(users.length, before); assert.equal(storedWorkspaces.get(workspaceId).members.length, 1); assert.equal(storedWorkspaces.get(workspaceId).capacityVersion, 0); assert.equal(sessionsStarted, sessionsEnded);
    });
    await t.test('transaction retry creates fresh users and commits one account with one membership', async () => {
      reset(); const before = users.length, creates = payloads.length; retry = true;
      assert.equal((await request(details('retry@example.com'))).status, 201); retry = false;
      assert.equal(payloads.length, creates + 2); assert.equal(users.length, before + 1); assert.equal(storedWorkspaces.get(workspaceId).members.length, 2); assert.equal(storedWorkspaces.get(workspaceId).capacityVersion, 1);
    });
    await t.test('zero seats and total-member capacity reject onboarding, including plan-inherited total quota', async () => {
      reset(); const before = users.length; storedWorkspaces.get(workspaceId).seatLimits.agent = 0;
      assert.equal((await request(details('no-seat@example.com'))).status, 403); assert.equal(users.length, before); assert.equal(storedWorkspaces.get(workspaceId).capacityVersion, 0);
      storedWorkspaces.get(workspaceId).seatLimits.agent = null; storedWorkspaces.get(workspaceId).limits.members = 1;
      assert.equal((await request(details('no-total@example.com'))).status, 403); assert.equal(users.length, before);
      const record = storedWorkspaces.get(workspaceId); record.limits = {}; record.plan = new mongoose.Types.ObjectId();
      assert.equal((await request(details('plan-first@example.com'))).status, 201);
      assert.equal((await request(details('plan-second@example.com'))).status, 403); assert.equal(storedWorkspaces.get(workspaceId).members.length, 2);
    });
    await t.test('parallel new accounts cannot claim the last seat twice; another business remains independent', async () => {
      reset(); storedWorkspaces.get(workspaceId).seatLimits.agent = 1;
      const before = users.length, results = await Promise.all([request(details('parallel-first@example.com')), request(details('parallel-second@example.com'))]);
      assert.deepEqual(results.map(result => result.status).sort(), [201, 403]); assert.equal(users.length, before + 1); assert.equal(storedWorkspaces.get(workspaceId).members.length, 2);
      assert.equal((await request({ ...details('independent@example.com'), workspaceId: otherId })).status, 201); assert.equal(storedWorkspaces.get(otherId).members.length, 2);
    });
    await t.test('unlinked legacy and platform account creation remain available without making company text a membership', async () => {
      const before = sessionsStarted;
      assert.equal((await request({ name: 'Platform operator', email: 'platform@example.com', password: 'LongPassword123', role: 'superadmin' })).status, 201);
      assert.equal(users.at(-1).role, 'superadmin'); assert.equal(users.at(-1).defaultWorkspace, undefined);
      assert.equal((await request({ name: 'Legacy owner', email: 'legacy@example.com', password: 'LongPassword123', role: 'owner', company: 'Legacy company' })).status, 201);
      assert.equal(users.at(-1).role, 'owner'); assert.equal(users.at(-1).company, 'Legacy company'); assert.equal(users.at(-1).defaultWorkspace, undefined); assert.equal(sessionsStarted, before);
    });
    await t.test('database superadmin permission and current sessions are required for association', async () => {
      const before = users.length; root.role = 'owner'; assert.equal((await request(details('forbidden@example.com'))).status, 403); root.role = 'superadmin';
      assert.equal((await request(details('stale@example.com'), 1)).status, 401); assert.equal(users.length, before); assert.equal(sessionsStarted, sessionsEnded); assert.ok(lockCalls > 0);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [target, key, original] of originals.reverse()) target[key] = original;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});
