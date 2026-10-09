import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import router from './superadmin.js';
import workspaceRouter from './workspaces.js';
import authRouter from './auth.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { Contact, Message } from '../models/Domain.js';
import { AdminAudit, FEATURES, PlatformInvoice, PlatformPlan, PlatformSettings } from '../models/Platform.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { auditAdminChanges } from '../middleware/superadmin.js';
import { checkSendingPolicy, workspaceFeatures } from '../services/platform.js';
import { ensureUserWorkspace } from '../services/workspace.js';

test('superadmin authorization, workspace isolation and operational controls', async t => {
  const userId = '507f1f77bcf86cd799439011';
  const workspaceId = '507f1f77bcf86cd799439012';
  const recordId = '507f1f77bcf86cd799439013';
  const env = { JWT_SECRET: process.env.JWT_SECRET, SMARTPING_AUTH_TOKEN: process.env.SMARTPING_AUTH_TOKEN };
  process.env.JWT_SECRET = 'unit-test-secret-not-a-real-credential';
  process.env.SMARTPING_AUTH_TOKEN = 'unit-test-provider-token';
  const originals = [];
  const mock = (object, key, value) => { originals.push([object, key, object[key]]); object[key] = value; };
  let user = { _id: new mongoose.Types.ObjectId(userId), name: 'Test administrator', role: 'superadmin', isActive: true, sessionVersion: 0, defaultWorkspace: workspaceId };
  let settings = { registrationEnabled: true, workspaceCreationEnabled: true, maintenanceEnabled: false, maintenanceMessage: 'Test maintenance notice', sendingEnabled: true };
  let workspace = { _id: workspaceId, isActive: true, sendingEnabled: true, disabledFeatures: [], members: [{ user: user._id, role: 'owner' }] };
  let workspaceFilter;
  const audits = [];
  mock(User, 'findById', async () => user);
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => settings }));
  mock(PlatformSettings, 'findOneAndUpdate', async (_filter, update) => { settings = { ...settings, ...update.$set }; return settings; });
  mock(Workspace, 'findOne', async filter => { workspaceFilter = filter; return workspace; });
  mock(Workspace, 'findById', () => ({ then: (resolve, reject) => Promise.resolve(workspace).then(resolve, reject), populate: async () => ({ ...workspace }) }));
  mock(Workspace, 'exists', async () => true);
  mock(AdminAudit, 'create', async item => { audits.push(item); return item; });
  const app = express(); app.use(express.json()); app.use(auditAdminChanges);
  app.use('/api/superadmin', router); app.use('/api/auth', authRouter); app.use('/api/workspaces', workspaceRouter);
  app.get('/api/conversations', requireAuth, requireWorkspace, (_req, res) => res.json({ items: [] }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const token = (role = 'superadmin', version = 0, issuer = 'waba-api') => jwt.sign({ sub: userId, role, version }, process.env.JWT_SECRET, { issuer, expiresIn: '1h' });
  const request = (path, method = 'GET', body, bearer = token(), headers = {}) => fetch(base + path, { method, headers: { Authorization: bearer ? `Bearer ${bearer}` : '', 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await t.test('authentication required and issuer validated', async () => {
      assert.equal((await request('/api/superadmin/catalogue', 'GET', undefined, '')).status, 401);
      assert.equal((await request('/api/superadmin/catalogue', 'GET', undefined, token('superadmin', 0, 'other-api'))).status, 401);
    });
    await t.test('database role, not token claim, determines superadmin access', async () => {
      user.role = 'owner';
      assert.equal((await request('/api/superadmin/catalogue')).status, 403);
      user.role = 'superadmin';
      assert.equal((await request('/api/superadmin/catalogue', 'GET', undefined, token('owner'))).status, 200);
    });
    await t.test('suspended users and revoked sessions cannot administer', async () => {
      user.isActive = false; assert.equal((await request('/api/superadmin/catalogue')).status, 401); user.isActive = true;
      user.sessionVersion = 1; assert.equal((await request('/api/superadmin/catalogue')).status, 401); user.sessionVersion = 0;
    });
    await t.test('archived accounts cannot sign in or authenticate even if active is accidentally re-enabled', async () => {
      user.deletedAt = new Date();
      try {
        assert.equal((await request('/api/superadmin/catalogue')).status, 401);
        const original = User.findOne;
        User.findOne = () => ({ select: async () => user });
        try { assert.equal((await request('/api/auth/login', 'POST', { email: 'archived@example.test', password: 'NotChecked123' })).status, 401); }
        finally { User.findOne = original; }
      } finally { delete user.deletedAt; }
    });
    await t.test('both deletion endpoints require database superadmin access', async () => {
      user.role = 'agent';
      try {
        for (const endpoint of ['preview', 'execute']) {
          assert.equal((await request(`/api/superadmin/deletions/${endpoint}`, 'POST', {})).status, 403);
          assert.equal((await request(`/api/superadmin/deletions/${endpoint}`, 'POST', {}, '')).status, 401);
        }
      } finally { user.role = 'superadmin'; }
    });
    await t.test('archived workspaces cannot be inspected even by superadmin', async () => {
      workspace.deletedAt = new Date();
      try { assert.equal((await request('/api/conversations')).status, 403); }
      finally { delete workspace.deletedAt; }
    });
    await t.test('provider credentials are never returned', async () => {
      const response = await request('/api/superadmin/integrations'); assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes('unit-test-provider-token'));
    });
    await t.test('cannot demote or suspend your own superadmin account', async () => {
      assert.equal((await request(`/api/superadmin/users/${userId}`, 'PATCH', { role: 'owner' })).status, 409);
      assert.equal((await request(`/api/superadmin/users/${userId}`, 'PATCH', { isActive: false })).status, 409);
    });
    await t.test('transaction guard prevents removal of the final active superadmin', async () => {
      const originalFind = User.findById, originalCount = User.countDocuments, originalSession = mongoose.startSession;
      let saved = false, ended = false, counted = false;
      const target = { _id: recordId, role: 'superadmin', isActive: true, save: async () => { saved = true; } };
      const session = { withTransaction: async callback => callback(), endSession: async () => { ended = true; } };
      mongoose.startSession = async () => session;
      User.findById = value => { const item = String(value) === userId ? user : target; return { then: (resolve, reject) => Promise.resolve(item).then(resolve, reject), session: async passed => { assert.equal(passed, session); return item; } }; };
      User.countDocuments = filter => ({ session: async passed => { assert.deepEqual(filter, { role: 'superadmin', isActive: true, deletedAt: null }); assert.equal(passed, session); counted = true; return 1; } });
      try {
        assert.equal((await request(`/api/superadmin/users/${recordId}`, 'PATCH', { role: 'owner' })).status, 409);
        assert.equal(saved, false); assert.equal(ended, true); assert.equal(counted, true);
      } finally { User.findById = originalFind; User.countDocuments = originalCount; mongoose.startSession = originalSession; }
    });
    await t.test('invalid roles, passwords and setting types fail before writes', async () => {
      assert.equal((await request('/api/superadmin/users', 'POST', { role: 'root', email: 'test@example.com', password: 'test-password' })).status, 400);
      assert.equal((await request('/api/superadmin/users', 'POST', { role: 'owner', email: 'test@example.com', password: 'short' })).status, 400);
      assert.equal((await request('/api/superadmin/settings', 'PATCH', { sendingEnabled: 'false' })).status, 400);
    });
    await t.test('workspace records require explicit scope and messages cannot have fabricated status', async () => {
      assert.equal((await request('/api/superadmin/data/contacts')).status, 400);
      assert.equal((await request(`/api/superadmin/data/messages/${recordId}?workspace=${workspaceId}`, 'PATCH', { status: 'delivered' })).status, 400);
      assert.equal((await request('/api/superadmin/data/__proto__')).status, 404);
    });
    await t.test('contact assignments cannot cross workspaces', async () => {
      mock(Contact, 'exists', async filter => { assert.equal(filter.workspace, workspaceId); return false; });
      assert.equal((await request('/api/superadmin/data/conversations', 'POST', { workspace: workspaceId, contact: recordId })).status, 400);
    });
    await t.test('contacts with conversations and campaigns with history cannot be deleted', async () => {
      mock(Message, 'exists', async () => true);
      assert.equal((await request(`/api/superadmin/data/campaigns/${recordId}?workspace=${workspaceId}`, 'DELETE')).status, 409);
    });
    await t.test('ordinary users cannot bypass membership with a workspace header', async () => {
      user.role = 'owner'; workspace = null;
      assert.equal((await request('/api/conversations', 'GET', undefined, token(), { 'X-Workspace-Id': workspaceId })).status, 403);
      assert.equal(String(workspaceFilter['members.user']), userId);
      workspace = { _id: workspaceId, isActive: true, sendingEnabled: true, disabledFeatures: [], members: [{ user: user._id, role: 'owner' }] };
    });
    await t.test('workspace suspension, expiry, disabled features and maintenance are API enforced', async () => {
      workspace.isActive = false; assert.equal((await request('/api/conversations')).status, 403); workspace.isActive = true;
      workspace.subscriptionEndsAt = new Date(0); assert.equal((await request('/api/conversations')).status, 403); delete workspace.subscriptionEndsAt;
      workspace.disabledFeatures = ['conversations']; assert.equal((await request('/api/conversations')).status, 403); workspace.disabledFeatures = [];
      settings.maintenanceEnabled = true; assert.equal((await request('/api/conversations')).status, 503); settings.maintenanceEnabled = false;
    });
    await t.test('superadmins can explicitly inspect suspended workspaces during maintenance', async () => {
      user.role = 'superadmin'; settings.maintenanceEnabled = true; workspace.isActive = false;
      const response = await request('/api/workspaces/current', 'GET', undefined, token(), { 'X-Workspace-Id': workspaceId });
      assert.equal(response.status, 200); assert.equal(workspaceFilter['members.user'], undefined);
      settings.maintenanceEnabled = false; workspace.isActive = true;
    });
    await t.test('sending emergency switch applies even to superadmins', async () => {
      settings.sendingEnabled = false; await assert.rejects(() => checkSendingPolicy(workspaceId), error => error.status === 403); settings.sendingEnabled = true;
      workspace.sendingEnabled = false; await assert.rejects(() => checkSendingPolicy(workspaceId), error => error.status === 403); workspace.sendingEnabled = true;
      workspace.disabledFeatures = ['templates']; await assert.rejects(() => checkSendingPolicy(workspaceId), error => error.status === 403); workspace.disabledFeatures = [];
      await checkSendingPolicy(workspaceId);
    });
    await t.test('plan entitlements and per-workspace restrictions are combined', async () => {
      mock(PlatformPlan, 'findById', () => ({ lean: async () => ({ features: ['contacts', 'templates'] }) }));
      assert.deepEqual(await workspaceFeatures({ plan: recordId, disabledFeatures: ['templates'] }), ['contacts']);
      assert.deepEqual(await workspaceFeatures({ disabledFeatures: [] }), FEATURES);
    });
    await t.test('registration and extra workspace creation switches block mutations', async () => {
      settings.registrationEnabled = false;
      assert.equal((await request('/api/auth/register', 'POST', { role: 'superadmin' }, '')).status, 403);
      settings.registrationEnabled = true; settings.workspaceCreationEnabled = false; user.role = 'owner';
      assert.equal((await request('/api/workspaces', 'POST', { name: 'Blocked workspace' })).status, 403);
      settings.workspaceCreationEnabled = true; user.role = 'superadmin';
    });
    await t.test('a removed agent is not automatically upgraded to workspace owner', async () => {
      workspace = null;
      const agent = { role: 'agent', _id: user._id };
      mock(Workspace, 'findOne', () => ({ select: async () => null }));
      assert.equal(await ensureUserWorkspace(agent), null);
    });
    await t.test('successful administrator writes are audited without secret values', async () => {
      const response = await request('/api/superadmin/settings', 'PATCH', { sendingEnabled: false, password: 'do-not-store-this', token: 'do-not-store-token' });
      assert.equal(response.status, 200);
      assert.equal(audits.length, 1);
      assert.deepEqual(audits[0].details.fields, ['sendingEnabled']);
      assert.ok(!JSON.stringify(audits).includes('do-not-store'));
      const publicSettings = await (await request('/api/auth/platform', 'GET', undefined, '')).json();
      assert.equal(publicSettings.sendingEnabled, undefined);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [object, key, original] of originals.reverse()) object[key] = original;
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('platform models reject invalid plans, invoice amounts and workspace controls', () => {
  assert.ok(new PlatformPlan({ name: 'Invalid', features: ['not-a-feature'] }).validateSync());
  assert.ok(new PlatformPlan({ name: 'Invalid', monthlyPrice: -1 }).validateSync());
  assert.ok(new PlatformInvoice({ amount: -1 }).validateSync());
  assert.equal(new PlatformSettings().registrationEnabled, true);
  assert.equal(new Workspace().sendingEnabled, true);
});
