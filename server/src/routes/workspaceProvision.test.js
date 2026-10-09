import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import superadminRouter from './superadmin.js';
import workspaceRouter from './workspaces.js';
import authRouter from './auth.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { PlatformPlan, PlatformSettings } from '../models/Platform.js';
import { createWorkspaceForUser } from '../services/workspace.js';

test('configured workspace provisioning is atomic and exclusive to superadmin creation', async t => {
  const adminId = '507f1f77bcf86cd799439011', ownerId = '507f1f77bcf86cd799439012', workspaceId = '507f1f77bcf86cd799439013', defaultPlan = '507f1f77bcf86cd799439014', chosenPlan = '507f1f77bcf86cd799439015';
  const secretBefore = process.env.JWT_SECRET; process.env.JWT_SECRET = 'workspace-provision-tests-only';
  const mocks = []; const mock = (object, key, value) => { mocks.push([object, key, object[key]]); object[key] = value; };
  let settings = { defaultPlan, trialDays: 14, defaultTimezone: 'UTC', workspaceLimitPerOwner: 0 };
  let started = 0, ended = 0, aborted = 0, saveFails = false, workspaceFails = false, ownerSaves = 0;
  let activePlans = new Set([defaultPlan, chosenPlan]); const planChecks = [], created = [];
  const admin = { _id: new mongoose.Types.ObjectId(adminId), role: 'superadmin', isActive: true, sessionVersion: 0, name: 'Admin', email: 'admin@example.com', defaultWorkspace: workspaceId, save: async () => {} };
  const owner = { _id: new mongoose.Types.ObjectId(ownerId), role: 'owner', isActive: true, name: 'Owner', company: 'Business', email: 'owner@example.com', defaultWorkspace: workspaceId, save: async options => { assert.equal(options.session, session); ownerSaves++; if (saveFails) throw new Error('Simulated save failure'); } };
  const session = {
    withTransaction: async callback => { const staged = []; session.staged = staged; try { await callback(); created.push(...staged); } catch (error) { aborted++; throw error; } },
    endSession: async () => { ended++; },
  };
  mock(mongoose, 'startSession', async () => { started++; return session; });
  mock(User, 'findById', async id => String(id) === adminId ? admin : String(id) === ownerId ? owner : null);
  mock(User, 'updateOne', async filter => { assert.equal(filter.deletedAt, null); assert.equal(filter.isActive, true); return { matchedCount: 1, modifiedCount: 1 }; });
  mock(User, 'exists', async () => false);
  mock(User, 'create', async (records, options) => { assert.equal(options.session, session); return [{ ...owner, ...records[0], defaultWorkspace: undefined, toSafeObject() { return { role: this.role, email: this.email, workspaceId: this.defaultWorkspace }; } }]; });
  mock(Workspace, 'countDocuments', () => ({ session: async () => 0 }));
  mock(Workspace, 'create', async (records, options) => { assert.equal(options.session, session); if (workspaceFails) throw new Error('Simulated workspace failure'); session.staged.push(...records); return [{ ...records[0], _id: workspaceId }]; });
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => settings }));
  mock(PlatformPlan, 'exists', filter => ({ session: async passed => { assert.equal(passed, session); planChecks.push(filter); return activePlans.has(String(filter._id)); } }));
  const app = express(); app.use(express.json()); app.use('/api/superadmin', superadminRouter); app.use('/api/workspaces', workspaceRouter); app.use('/api/auth', authRouter);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const token = version => jwt.sign({ sub: adminId, role: 'superadmin', version: version || 0 }, process.env.JWT_SECRET, { issuer: 'waba-api', expiresIn: '1h' });
  const request = (path, body, bearer = token()) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
  const create = body => request('/api/superadmin/workspaces', { name: 'Business', owner: ownerId, ...body });
  try {
    await t.test('omitted configuration inherits the platform plan, trial and timezone', async () => {
      const before = Date.now(); const response = await create({}); assert.equal(response.status, 201);
      const item = created.at(-1); assert.equal(item.plan, defaultPlan); assert.equal(item.settings.timezone, 'UTC'); assert.equal(item.settings.supportEmail, owner.email);
      assert.ok(item.subscriptionEndsAt.getTime() >= before + 14 * 86400000 && item.subscriptionEndsAt.getTime() <= Date.now() + 14 * 86400000);
      assert.deepEqual(item.members, [{ user: owner._id, role: 'owner' }]); assert.equal(owner.defaultWorkspace, workspaceId); assert.equal(started, ended);
    });
    await t.test('complete configuration is persisted together and an explicit plan bypasses stale global default', async () => {
      activePlans.delete(defaultPlan); const checks = planChecks.length;
      const response = await create({ plan: chosenPlan, subscriptionEndsAt: '2035-04-05T12:00:00Z', isActive: false, sendingEnabled: false, disabledFeatures: ['ads', 'automations'], settings: { timezone: 'Asia/Kolkata', supportEmail: 'support@example.com', businessDescription: 'Company information', unknown: 'ignored' }, limits: { contacts: 10, members: null, campaigns: 0 }, adminNotes: 'Private notes' });
      assert.equal(response.status, 201); const item = created.at(-1);
      assert.equal(planChecks.length, checks + 1); assert.equal(planChecks.at(-1)._id, chosenPlan);
      assert.equal(item.plan, chosenPlan); assert.equal(item.subscriptionEndsAt.toISOString(), '2035-04-05T12:00:00.000Z'); assert.equal(item.isActive, false); assert.equal(item.sendingEnabled, false);
      assert.deepEqual(item.disabledFeatures, ['ads', 'automations']); assert.deepEqual(item.limits, { contacts: 10, members: null, campaigns: 0 }); assert.equal(item.adminNotes, 'Private notes');
      assert.deepEqual(item.settings, { timezone: 'Asia/Kolkata', supportEmail: 'support@example.com', businessDescription: 'Company information' });
    });
    await t.test('explicit no-plan, no-expiry and zero trial override inherited defaults', async () => {
      const checks = planChecks.length;
      assert.equal((await create({ plan: null, subscriptionEndsAt: null, settings: { supportEmail: '' } })).status, 201);
      assert.equal(planChecks.length, checks); assert.equal(created.at(-1).plan, null); assert.equal(created.at(-1).subscriptionEndsAt, null); assert.equal(created.at(-1).settings.timezone, 'UTC'); assert.equal(created.at(-1).settings.supportEmail, '');
      assert.equal((await create({ plan: null, trialDays: 0 })).status, 201); assert.equal(created.at(-1).subscriptionEndsAt, null);
      const before = Date.now(); assert.equal((await create({ plan: null, trialDays: 3 })).status, 201);
      assert.ok(created.at(-1).subscriptionEndsAt.getTime() >= before + 3 * 86400000 && created.at(-1).subscriptionEndsAt.getTime() <= Date.now() + 3 * 86400000);
    });
    await t.test('invalid controls and unavailable owners fail without opening a transaction', async () => {
      const before = started, count = created.length;
      for (const body of [{ name: '' }, { isActive: 'false' }, { plan: 'bad' }, { subscriptionEndsAt: 'bad' }, { trialDays: 5, subscriptionEndsAt: null }, { disabledFeatures: ['bad'] }, { limits: { unknown: 1 } }, { settings: { supportEmail: 'bad' } }, { settings: { timezone: 'Bad/Timezone' } }]) assert.equal((await create(body)).status, 400);
      assert.equal((await create({ owner: chosenPlan })).status, 400);
      owner.isActive = false; assert.equal((await create({})).status, 400); owner.isActive = true;
      assert.equal(started, before); assert.equal(created.length, count);
    });
    await t.test('inactive plans abort the transaction with no created workspace', async () => {
      const count = created.length;
      assert.equal((await create({ plan: defaultPlan })).status, 409); assert.equal(created.length, count);
      assert.equal((await create({})).status, 409); assert.equal(created.length, count); assert.equal(started, ended);
    });
    await t.test('owner save failure rolls back workspace and in-memory default and closes session', async () => {
      const count = created.length; owner.defaultWorkspace = undefined; saveFails = true;
      assert.equal((await create({ plan: null })).status, 500); assert.equal(created.length, count); assert.equal(owner.defaultWorkspace, undefined); assert.equal(started, ended);
      saveFails = false;
      assert.equal((await create({ plan: null })).status, 201); assert.equal(owner.defaultWorkspace, workspaceId);
      workspaceFails = true; assert.equal((await create({ plan: null })).status, 500); workspaceFails = false; assert.equal(started, ended);
    });
    await t.test('creation requires authenticated database superadmin role and current session', async () => {
      const count = created.length;
      assert.equal((await request('/api/superadmin/workspaces', { name: 'Business', owner: ownerId }, '')).status, 401);
      admin.role = 'owner'; assert.equal((await create({ plan: null })).status, 403); admin.role = 'superadmin';
      assert.equal((await request('/api/superadmin/workspaces', { name: 'Business', owner: ownerId }, token(1))).status, 401);
      assert.equal(created.length, count);
    });
    await t.test('normal workspace creation ignores submitted administrator-only controls', async () => {
      activePlans.add(defaultPlan); settings.workspaceLimitPerOwner = null; admin.role = 'owner';
      const response = await request('/api/workspaces', { name: 'Ordinary workspace', plan: null, subscriptionEndsAt: null, trialDays: 365, sendingEnabled: false, isActive: false, settings: { timezone: 'Europe/London' }, limits: { contacts: 0 }, adminNotes: 'Not allowed' });
      assert.equal(response.status, 201); const item = created.at(-1); assert.equal(item.plan, defaultPlan); assert.equal(item.settings.timezone, 'UTC');
      for (const key of ['limits', 'adminNotes', 'isActive', 'sendingEnabled']) assert.equal(item[key], undefined);
      assert.ok(item.subscriptionEndsAt > new Date()); admin.role = 'superadmin';
    });
    await t.test('registration ignores administrator-only controls and shares its caller transaction', async () => {
      const before = started;
      const response = await request('/api/auth/register', { name: 'New owner', company: 'Registered business', email: 'registered@example.com', password: 'long-test-password', plan: null, subscriptionEndsAt: null, trialDays: 365, settings: { timezone: 'Europe/London' }, limits: { contacts: 0 }, adminNotes: 'Not allowed' }, '');
      assert.equal(response.status, 201); const item = created.at(-1); assert.equal(item.plan, defaultPlan); assert.equal(item.settings.timezone, 'UTC'); assert.equal(item.limits, undefined); assert.equal(item.adminNotes, undefined);
      assert.equal(started, before + 1); assert.equal(started, ended);
    });
    await t.test('shared provisioning respects an existing caller-owned session', async () => {
      const before = started; session.staged = [];
      await createWorkspaceForUser(owner, 'External transaction', { session, settings, bypassLimit: true, preserveDefault: true, initialConfiguration: { plan: null, trialDays: 0 } });
      assert.equal(started, before); assert.equal(session.staged[0].subscriptionEndsAt, null); assert.equal(session.staged[0].plan, null);
      assert.ok(aborted >= 4);
    });
    await t.test('a transaction retry still saves the first owner default after an aborted attempt', async () => {
      const originalTransaction = session.withTransaction, count = created.length, saves = ownerSaves;
      owner.defaultWorkspace = undefined;
      session.withTransaction = async callback => {
        session.staged = []; await callback(); // The driver aborts this attempt.
        session.staged = []; await callback(); created.push(...session.staged);
      };
      try {
        await createWorkspaceForUser(owner, 'Retry business', { settings, bypassLimit: true, preserveDefault: true, initialConfiguration: { plan: null } });
        assert.equal(ownerSaves, saves + 2); assert.equal(owner.defaultWorkspace, workspaceId); assert.equal(created.length, count + 1); assert.equal(started, ended);
      } finally { session.withTransaction = originalTransaction; }
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [object, key, value] of mocks.reverse()) object[key] = value;
    if (secretBefore === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secretBefore;
  }
});
