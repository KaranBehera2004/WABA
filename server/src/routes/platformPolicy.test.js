import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import authRouter from './auth.js';
import superadminRouter from './superadmin.js';
import workspaceRouter from './workspaces.js';
import smartpingRouter from './smartping.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { Campaign, Contact } from '../models/Domain.js';
import { PlatformPlan, PlatformSettings } from '../models/Platform.js';
import { requireAuth } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { checkSendingPolicy } from '../services/platform.js';
import { AuthSession } from '../models/Business.js';

test('platform policies are enforced by real routes without using a database or provider', async t => {
  const userId = '507f1f77bcf86cd799439011', workspaceId = '507f1f77bcf86cd799439012', planId = '507f1f77bcf86cd799439013';
  const env = { JWT_SECRET: 'platform-policy-test-only', SMARTPING_WORKSPACE_ID: workspaceId, SMARTPING_JOURNEY_ID: 'test-journey', SMARTPING_FROM: '+919876543210', SMARTPING_AUTH_TOKEN: 'test-only-token', SMARTPING_CALLBACK_BASE_URL: '' };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const mocks = []; const mock = (model, key, fn) => { mocks.push([model, key, model[key]]); model[key] = fn; };
  let settings = {}, activePlan = true, ownedCount = 0, settingsWrites = 0, userSaves = 0, sessionsStarted = 0, sessionsEnded = 0, aborted = 0;
  const createdUsers = [], createdWorkspaces = [], provisionLocks = [], planChecks = [];
  const user = {
    _id: new mongoose.Types.ObjectId(userId), role: 'superadmin', isActive: true, sessionVersion: 0,
    name: 'Policy tester', email: 'owner@example.com', company: 'Policy workspace', defaultWorkspace: workspaceId,
    comparePassword: async () => true, save: async () => { userSaves++; },
    toSafeObject() { return { id: String(this._id), role: this.role, name: this.name, email: this.email, workspaceId: this.defaultWorkspace }; },
  };
  const workspace = { _id: workspaceId, isActive: true, sendingEnabled: true, disabledFeatures: [], members: [{ user: user._id, role: 'owner' }] };
  const session = { withTransaction: async fn => { try { await fn(); } catch (error) { aborted++; throw error; } }, endSession: async () => { sessionsEnded++; } };
  mock(mongoose, 'startSession', async () => { sessionsStarted++; return session; });
  mock(User, 'findById', async () => user);
  mock(User, 'findOne', () => ({ select: async () => user }));
  mock(User, 'exists', async () => false);
  mock(AuthSession, 'create', async item => { assert.equal(String(item.user),userId); assert.ok(item.key); assert.ok(item.expiresAt instanceof Date); return item; });
  mock(User, 'updateOne', async (filter, update, options) => { assert.equal(options.session, session); assert.equal(filter.deletedAt, null); assert.equal(filter.isActive, true); provisionLocks.push({ filter, update }); return { matchedCount: 1, modifiedCount: 1 }; });
  mock(User, 'create', async (items, options) => {
    assert.equal(options.session, session); assert.ok(Array.isArray(items)); createdUsers.push(...items);
    const item = { ...user, ...items[0], defaultWorkspace: undefined }; return [item];
  });
  mock(Workspace, 'findOne', async () => workspace);
  mock(Workspace, 'findById', async () => workspace);
  mock(Workspace, 'find', () => ({ select: async () => [{ _id: workspaceId, name: 'Policy workspace' }] }));
  mock(Workspace, 'countDocuments', filter => ({ session: async passed => { assert.equal(passed, session); assert.equal(String(filter.owner), userId); return ownedCount; } }));
  mock(Workspace, 'create', async (items, options) => { assert.equal(options.session, session); createdWorkspaces.push(...items); return [{ ...items[0], _id: workspaceId }]; });
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => settings }));
  mock(PlatformSettings, 'findOneAndUpdate', async (filter, update, options) => { assert.equal(filter.key, 'platform'); assert.equal(options.runValidators, true); settingsWrites++; settings = { ...settings, ...update.$set }; return settings; });
  mock(PlatformPlan, 'exists', filter => {
    planChecks.push(filter);
    return { session: async passed => { assert.equal(passed, session); return activePlan; }, then: (resolve, reject) => Promise.resolve(activePlan).then(resolve, reject) };
  });
  // These methods must not run for a blocked or invalid broadcast request.
  mock(Contact, 'find', async () => { throw new Error('Recipient database access must not occur.'); });
  mock(Campaign, 'findOneAndUpdate', async () => { throw new Error('Campaign must not be claimed.'); });
  const app = express(); app.use(express.json());
  app.use('/api/auth', authRouter); app.use('/api/superadmin', superadminRouter); app.use('/api/workspaces', workspaceRouter); app.use('/api/integrations/smartping', smartpingRouter);
  app.get('/api/conversations', requireAuth, requireWorkspace, (_req, res) => res.json({ allowed: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt.sign({ sub: userId, version: 0 }, env.JWT_SECRET, { issuer: 'waba-api', expiresIn: '1h' }) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const registration = { name: 'New owner', company: 'New business', email: 'new@example.com', password: 'Longpassword1' };
  try {
    await t.test('public config includes real branding but redacts private control fields', async () => {
      settings = { platformName: 'My platform', supportUrl: 'https://example.com/help', allowedSignupDomains: ['example.com'], defaultPlan: planId, sessionLifetimeHours: 2, controlVersion: 42 };
      const response = await request('/api/auth/platform'); assert.equal(response.status, 200); const data = await response.json();
      assert.equal(data.platformName, 'My platform'); assert.equal(data.supportUrl, 'https://example.com/help'); assert.equal(data.signupRestricted, true); assert.equal(data.registrationEnabled, true);
      for (const key of ['allowedSignupDomains', 'defaultPlan', 'sessionLifetimeHours', 'controlVersion', 'sendingEnabled', 'disabledFeatures']) assert.equal(data[key], undefined);
      assert.equal(data.passwordMinLength, 8); assert.equal(data.memberAccessEnabled, true);
    });
    await t.test('new platform setting endpoints remain superadmin-only', async () => {
      user.role = 'owner';
      assert.equal((await request('/api/superadmin/settings')).status, 403);
      assert.equal((await request('/api/superadmin/settings', 'PATCH', { platformName: 'Not allowed' })).status, 403);
      assert.equal(settingsWrites, 0); user.role = 'superadmin';
    });
    await t.test('invalid settings and archived default plans fail before persistence', async () => {
      for (const body of [{ memberAccessEnabled: 'false' }, { maxBroadcastRecipients: 101 }, { passwordMinLength: 7 }, { defaultTimezone: 'Bad/Timezone' }, { allowedSignupDomains: ['@example.com'] }, { termsUrl: 'javascript:alert(1)' }]) assert.equal((await request('/api/superadmin/settings', 'PATCH', body)).status, 400);
      activePlan = false;
      assert.equal((await request('/api/superadmin/settings', 'PATCH', { defaultPlan: planId })).status, 400);
      assert.equal(settingsWrites, 0); activePlan = true;
    });
    await t.test('saving supported controls preserves unrelated fields and strips unknown keys', async () => {
      const response = await request('/api/superadmin/settings', 'PATCH', { defaultPlan: planId, trialDays: 14, defaultTimezone: 'UTC', passwordMinLength: 12, passwordRequireNumber: true, footerText: 'Support is available', workspaceLimitPerOwner: 2, secret: 'never-store', controlVersion: 999 });
      assert.equal(response.status, 200); const data = await response.json();
      assert.equal(data.settings.platformName, 'My platform'); assert.equal(data.settings.defaultPlan, planId); assert.equal(data.settings.footerText, 'Support is available');
      assert.equal(data.settings.controlVersion, 42); assert.equal(settings.secret, undefined); assert.equal(settingsWrites, 1);
      assert.equal(planChecks.at(-1).isActive, true);
    });
    await t.test('signup domain and password restrictions reject before account creation', async () => {
      assert.equal((await request('/api/auth/register', 'POST', { ...registration, email: 'new@other.com' })).status, 403);
      assert.equal((await request('/api/auth/register', 'POST', { ...registration, password: 'password' })).status, 400);
      assert.equal((await request('/api/auth/register', 'POST', { ...registration, password: 'Longpassword' })).status, 400);
      assert.equal(createdUsers.length, 0); assert.equal(sessionsStarted, 0);
    });
    await t.test('registration applies workspace defaults atomically and cannot self-grant superadmin', async () => {
      const before = Date.now();
      const response = await request('/api/auth/register', 'POST', { ...registration, email: 'NEW@EXAMPLE.COM', role: 'superadmin', defaultPlan: null });
      assert.equal(response.status, 201); const data = await response.json();
      assert.equal(data.user.role, 'owner'); assert.equal(data.user.email, 'new@example.com'); assert.equal(data.user.workspaceId, workspaceId);
      assert.equal(createdUsers[0].role, 'owner'); assert.equal(createdWorkspaces[0].plan, planId); assert.equal(createdWorkspaces[0].settings.timezone, 'UTC');
      const expiry = createdWorkspaces[0].subscriptionEndsAt.getTime(); assert.ok(expiry >= before + 14 * 86400000 && expiry <= Date.now() + 14 * 86400000);
      assert.equal(provisionLocks[0].update.$inc.workspaceProvisionVersion, 1);
      assert.equal(sessionsStarted, 1); assert.equal(sessionsEnded, 1);
      const token = jwt.verify(data.token, env.JWT_SECRET, { issuer: 'waba-api' }); assert.equal(token.exp - token.iat, 7200); assert.equal(token.role, 'owner');
    });
    await t.test('an unavailable configured plan aborts signup, rather than creating unrestricted workspace', async () => {
      activePlan = false;
      const response = await request('/api/auth/register', 'POST', registration); assert.equal(response.status, 409);
      assert.equal(createdWorkspaces.length, 1); assert.equal(aborted, 1); assert.equal(sessionsEnded, sessionsStarted);
      activePlan = true;
    });
    await t.test('ordinary workspace quota serializes on the owner and rejects excess creation', async () => {
      user.role = 'owner'; ownedCount = 2;
      const response = await request('/api/workspaces', 'POST', { name: 'Excess workspace' }); assert.equal(response.status, 403);
      assert.match((await response.json()).message, /creation limit/); assert.equal(createdWorkspaces.length, 1); assert.equal(aborted, 2);
      assert.equal(sessionsEnded, sessionsStarted); assert.equal(String(provisionLocks.at(-1).filter._id), userId);
    });
    await t.test('zero owner quota blocks public registration without starting a transaction', async () => {
      settings.workspaceLimitPerOwner = 0; const before = sessionsStarted;
      const publicConfig = await (await request('/api/auth/platform')).json(); assert.equal(publicConfig.registrationEnabled, false);
      assert.equal((await request('/api/auth/register', 'POST', registration)).status, 403); assert.equal(sessionsStarted, before);
      settings.workspaceLimitPerOwner = 2;
    });
    await t.test('paused member access blocks existing sessions and new ordinary logins', async () => {
      settings.memberAccessEnabled = false; const before = userSaves;
      for (const [path, method, body] of [['/api/conversations', 'GET'], ['/api/workspaces', 'GET'], ['/api/workspaces', 'POST', { name: 'Blocked' }], ['/api/auth/login', 'POST', { email: user.email, password: 'old-password' }]]) assert.equal((await request(path, method, body)).status, 503);
      assert.equal(userSaves, before);
      assert.equal((await request('/api/auth/register', 'POST', registration)).status, 403);
      assert.equal((await (await request('/api/auth/platform')).json()).registrationEnabled, false);
    });
    await t.test('superadmin can sign in and inspect workspaces while member access is paused', async () => {
      user.role = 'superadmin'; const response = await request('/api/auth/login', 'POST', { email: user.email, password: 'old-password' });
      assert.equal(response.status, 200); const data = await response.json();
      const token = jwt.verify(data.token, env.JWT_SECRET, { issuer: 'waba-api' }); assert.equal(token.exp - token.iat, 7200);
      assert.equal((await request('/api/conversations')).status, 200); assert.equal((await request('/api/workspaces')).status, 200);
      settings.memberAccessEnabled = true;
    });
    await t.test('existing passwords still log in after stronger new-password rules are saved', async () => {
      user.role = 'owner'; settings.passwordMinLength = 40; settings.passwordRequireUppercase = true;
      assert.equal((await request('/api/auth/login', 'POST', { email: user.email, password: 'old-password' })).status, 200);
      settings.passwordMinLength = 12;
    });
    await t.test('global feature restrictions block ordinary API access but allow admin inspection', async () => {
      settings.disabledFeatures = ['conversations'];
      assert.equal((await request('/api/conversations')).status, 403); assert.equal((await request('/API/CONVERSATIONS/')).status, 403);
      user.role = 'superadmin'; assert.equal((await request('/api/conversations')).status, 200);
      await assert.rejects(() => checkSendingPolicy(workspaceId), error => error.status === 403);
      settings.disabledFeatures = [];
    });
    await t.test('broadcast switch stops campaign sends without blocking individual templates', async () => {
      settings.broadcastsEnabled = false;
      await checkSendingPolicy(workspaceId);
      await assert.rejects(() => checkSendingPolicy(workspaceId, { broadcast: true }), error => error.status === 403);
      assert.equal((await request('/api/integrations/smartping/campaigns/' + planId + '/send', 'POST', {})).status, 409);
      settings.broadcastsEnabled = true;
      settings.disabledFeatures = ['campaigns'];
      await assert.rejects(() => checkSendingPolicy(workspaceId, { broadcast: true }), error => error.status === 403);
      settings.disabledFeatures = [];
    });
    await t.test('broadcast recipient cap and duplicate validation run before claiming a campaign', async () => {
      settings.maxBroadcastRecipients = 1;
      const path = '/api/integrations/smartping/campaigns/' + planId + '/send';
      const body = { template: { templateId: 'approved-test-template' }, contactIds: [userId, workspaceId], idempotencyKey: 'unique-test-request' };
      const response = await request(path, 'POST', body); assert.equal(response.status, 409); assert.match((await response.json()).message, /background launch/);
      settings.maxBroadcastRecipients = 100;
      assert.equal((await request(path, 'POST', { ...body, contactIds: [userId, userId] })).status, 409);
    });
    await t.test('superadmin bypasses owner quota and creation switch while preserving new defaults', async () => {
      settings.workspaceLimitPerOwner = 0; settings.workspaceCreationEnabled = false; const locks = provisionLocks.length;
      assert.equal((await request('/api/workspaces', 'POST', { name: 'Admin workspace' })).status, 201);
      assert.equal(provisionLocks.length, locks + 1); assert.equal(createdWorkspaces.at(-1).plan, planId); assert.equal(createdWorkspaces.at(-1).settings.timezone, 'UTC');
      assert.equal(sessionsStarted, sessionsEnded);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [model, key, fn] of mocks.reverse()) model[key] = fn;
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
