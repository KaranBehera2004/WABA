import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import superadminRouter from './superadmin.js';
import { businessWallet } from './wallet.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { PlatformSettings } from '../models/Platform.js';
import { TestWallet, WalletConfig, WalletEntry } from '../models/Wallet.js';
import { ACTIVITY_PRICES } from '../services/walletConfig.js';

test('wallet API prevents tenant tampering and enforces root-only prices and adjustments', async t => {
  const userId = '507f1f77bcf86cd799439011', workspaceId = '507f1f77bcf86cd799439012', otherId = '507f1f77bcf86cd799439013';
  const previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'wallet-route-test-only';
  const originals = []; const mock = (Model, key, fn) => { originals.push([Model, key, Model[key]]); Model[key] = fn; };
  const user = { _id: new mongoose.Types.ObjectId(userId), role: 'owner', isActive: true, sessionVersion: 0, defaultWorkspace: workspaceId };
  const workspace = { _id: workspaceId, members: [{ user: user._id, role: 'owner' }], limits: {}, disabledFeatures: [] };
  const wallet = { workspace: workspaceId, balancePaise: 600000, mode: 'test', currency: 'INR' };
  let config = { deductionsEnabled: true, openingMinPaise: 500000, openingMaxPaise: 1000000, prices: { ...ACTIVITY_PRICES } }, configWrites = 0, ledgerFilter;
  const entries = [];
  const query = value => { const q = { session: () => q, lean: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) }; return q; };
  const session = { withTransaction: async fn => { const snapshot = JSON.parse(JSON.stringify(config)); try { await fn(); } catch (error) { config = snapshot; throw error; } }, endSession: async () => {} };
  mock(mongoose, 'startSession', async () => session);
  mock(User, 'findById', async () => user);
  mock(Workspace, 'findOne', async filter => filter['members.user'] && String(filter._id) !== workspaceId ? null : workspace);
  mock(Workspace, 'exists', filter => query(String(filter._id) === workspaceId));
  mock(Workspace, 'findOneAndUpdate', async (filter, update, options) => { assert.equal(options.session,session); assert.equal(update.$inc.capacityVersion,1); return String(filter._id)===workspaceId ? workspace : null; });
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => ({ maintenanceEnabled: false }) }));
  mock(WalletConfig, 'findOne', () => query(config));
  mock(WalletConfig, 'findOneAndUpdate', async (_filter, update, options) => {
    assert.equal(options.session, session);
    if (update.$set) { configWrites++; for (const [key, value] of Object.entries(update.$set)) { if (key.startsWith('prices.')) config.prices[key.slice(7)] = value; else config[key] = value; } }
    return config;
  });
  mock(TestWallet, 'findOne', filter => query(filter.workspace === workspaceId ? wallet : null));
  mock(TestWallet, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(options.session, session); if (wallet.balancePaise < filter.balancePaise.$gte || wallet.balancePaise > filter.balancePaise.$lte) return null;
    wallet.balancePaise += update.$inc.balancePaise; return wallet;
  });
  mock(WalletEntry, 'find', filter => { ledgerFilter = filter; const q = { populate: (_path, fields) => { assert.equal(fields, 'name'); return q; }, sort: () => q, limit: count => { assert.equal(count, 51); return q; }, lean: async () => entries }; return q; });
  mock(WalletEntry, 'findOne', filter => query(entries.find(row => row.workspace === filter.workspace && row.operationKey === filter.operationKey) || null));
  mock(WalletEntry, 'create', async (items, options) => { assert.equal(options.session, session); const rows = items.map(row => ({ ...row, _id: new mongoose.Types.ObjectId().toString() })); entries.push(...rows); return rows; });
  const app = express(); app.use(express.json()); app.use('/api/superadmin', superadminRouter); app.use('/api/wallet', businessWallet);
  app.use((_req, res) => res.status(404).json({ message: 'No such action.' }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, method = 'GET', body, headers = {}) => fetch(base + path, { method, headers: { Authorization: 'Bearer ' + jwt.sign({ sub: userId, role: 'superadmin', version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' }), 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await t.test('token role claims cannot grant a tenant price or top-up permission', async () => {
      assert.equal((await request('/api/superadmin/wallets/config')).status, 403);
      assert.equal((await request('/api/superadmin/wallets/config', 'PATCH', { prices: { contacts: 0 } })).status, 403);
      assert.equal((await request(`/api/superadmin/wallets/${workspaceId}/adjust`, 'POST', { amountPaise: 999999 })).status, 403);
      assert.equal((await request('/api/superadmin/wallets/initialize', 'POST', { confirmation: 'INITIALIZE TEST WALLETS' })).status, 403);
      assert.equal(configWrites, 0); assert.equal(entries.length, 0);
    });
    await t.test('wallet scope uses authenticated membership, never query/body workspace values', async () => {
      const response = await request('/api/wallet?workspace=' + otherId); assert.equal(response.status, 200); const data = await response.json();
      assert.equal(data.wallet.workspace, workspaceId); assert.equal(ledgerFilter.workspace, workspaceId);
      assert.equal((await request('/api/wallet', 'GET', undefined, { 'X-Workspace-Id': otherId })).status, 403);
      assert.equal((await request('/api/wallet', 'POST', { balancePaise: 99999999 })).status, 404); assert.equal(wallet.balancePaise, 600000);
      assert.equal((await request('/api/wallet?before=not-an-id')).status, 400);
    });
    await t.test('demo spending needs an explicit spending role, activity permission and enabled feature', async () => {
      const path = '/api/wallet/demo-activity', body = { activity: 'calls', idempotencyKey: 'demo-permission-key' };
      assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
      workspace.members[0].role = 'viewer'; workspace.permissionRules = [{ role: 'viewer', permissions: ['wallet.read', 'calls.create'] }];
      assert.equal((await request(path, 'POST', body)).status, 403, 'wallet.read and a token root claim must not bypass the viewer role');
      workspace.members[0].role = 'agent'; workspace.permissionRules = [{ role: 'agent', permissions: ['wallet.read'] }];
      assert.equal((await request(path, 'POST', body)).status, 403);
      workspace.permissionRules[0].permissions.push('calls.create'); workspace.disabledFeatures = ['calls'];
      assert.equal((await request(path, 'POST', body)).status, 403);
      workspace.disabledFeatures = []; workspace.permissionRules[0].permissions = ['calls.create'];
      assert.equal((await request(path, 'POST', body)).status, 403, 'members without wallet.read cannot see receipts or spend from the demo tester');
      assert.equal(wallet.balancePaise, 600000); assert.equal(entries.length, 0);
      workspace.members[0].role = 'owner'; workspace.permissionRules = [];
    });
    await t.test('demo API returns an actual scoped deduction, never client prices or replay deductions', async () => {
      const path = '/api/wallet/demo-activity', body = { activity: 'calls', idempotencyKey: 'demo-route-key', workspace: otherId, amountPaise: 0, quantity: 1000, mode: 'live' };
      try {
        let response = await request(path, 'POST', body); assert.equal(response.status, 201);
        let result = await response.json(); assert.equal(result.chargedPaise, 500); assert.equal(result.mode, 'test'); assert.equal(result.currency, 'INR'); assert.equal(result.walletCharges.length, 1);
        assert.equal(result.walletCharges[0].workspace, workspaceId); assert.equal(result.walletCharges[0].balanceAfterPaise, 599500); assert.equal(wallet.balancePaise, 599500);
        assert.equal(entries.length, 1); assert.match(entries[0].reason, /No provider action or business record/); assert.equal(String(entries[0].actor), userId);
        response = await request(path, 'POST', body); assert.equal(response.status, 200); result = await response.json(); assert.equal(result.duplicate, true); assert.equal(result.chargedPaise, 0); assert.deepEqual(result.walletCharges, []); assert.equal(wallet.balancePaise, 599500);
        assert.equal((await request(path, 'POST', { ...body, activity: 'messages' })).status, 409);
        assert.equal((await request(path, 'POST', { activity: 'unknown', idempotencyKey: 'demo-invalid-key' })).status, 400);
        assert.equal((await request(path, 'POST', { activity: 'calls' })).status, 400);
        assert.equal((await request(path, 'POST', body, { 'X-Workspace-Id': otherId })).status, 403);
        config.deductionsEnabled = false; result = await (await request(path, 'POST', { activity: 'calls', idempotencyKey: 'demo-paused-key' })).json(); assert.equal(result.chargedPaise, 0); assert.deepEqual(result.walletCharges, []); assert.match(result.reason, /paused/);
        config.deductionsEnabled = true; config.prices.calls = 0; result = await (await request(path, 'POST', { activity: 'calls', idempotencyKey: 'demo-free-key' })).json(); assert.equal(result.chargedPaise, 0); assert.deepEqual(result.walletCharges, []);
        config.prices.calls = 1000000; assert.equal((await request(path, 'POST', { activity: 'calls', idempotencyKey: 'demo-insufficient-key' })).status, 402); assert.equal(wallet.balancePaise, 599500);
      } finally { wallet.balancePaise = 600000; entries.length = 0; config.deductionsEnabled = true; config.prices.calls = ACTIVITY_PRICES.calls; }
    });
    await t.test('wallet access can be denied through the existing permission matrix', async () => {
      workspace.members[0].role = 'viewer'; workspace.permissionRules = [{ role: 'viewer', permissions: [] }];
      assert.equal((await request('/api/wallet')).status, 403); assert.equal((await request('/api/wallet/summary')).status, 403);
      workspace.members[0].role = 'owner'; workspace.permissionRules = []; user.role = 'superadmin';
    });
    await t.test('wallet view and deductions use this business custom rates while global defaults stay unchanged', async () => {
      workspace.customPlan={activityPricesPaise:{contacts:40,calls:125}};
      try {
        const view=await (await request('/api/wallet/summary')).json();assert.equal(view.settings.prices.contacts,40);assert.equal(view.settings.prices.calls,125);assert.equal(view.settings.pricingSource,'custom');assert.equal(config.prices.contacts,100);
        const result=await(await request('/api/wallet/demo-activity','POST',{activity:'calls',idempotencyKey:'custom-rate-demo-key'})).json();assert.equal(result.chargedPaise,125);
        delete workspace.customPlan;const restored=await(await request('/api/wallet/summary')).json();assert.equal(restored.settings.prices.calls,ACTIVITY_PRICES.calls);assert.equal(restored.settings.pricingSource,'default');assert.equal(entries.at(-1).unitPricePaise,125);
      } finally { delete workspace.customPlan;wallet.balancePaise=600000;entries.length=0; }
    });
    await t.test('root saves partial prices but cannot turn the wallet into real funds', async () => {
      const response = await request('/api/superadmin/wallets/config', 'PATCH', { prices: { contacts: 25 }, mode: 'live', currency: 'USD', balancePaise: 10 });
      assert.equal(response.status, 200); const data = await response.json(); assert.equal(data.settings.prices.contacts, 25); assert.equal(data.settings.prices.messages, 75);
      assert.equal(config.mode, undefined); assert.equal(config.currency, undefined); assert.equal(config.balancePaise, undefined); assert.equal(configWrites, 1);
      assert.equal((await request('/api/superadmin/wallets/config', 'PATCH', { openingMinPaise: 1000001 })).status, 400);
      assert.equal(config.openingMinPaise, 500000); assert.equal(configWrites, 1);
      assert.equal((await request('/api/superadmin/wallets/config', 'PATCH', { prices: { contacts: -1 } })).status, 400);
    });
    await t.test('root adjustments validate reasons, reject overdraws, and do not repeat on retries', async () => {
      const path = `/api/superadmin/wallets/${workspaceId}/adjust`, payload = { direction: 'credit', amountPaise: 12345, reason: 'Testing use', idempotencyKey: 'route-adjustment-key' };
      assert.equal((await request(path, 'POST', { ...payload, reason: '' })).status, 400);
      assert.equal((await request(path, 'POST', payload)).status, 201); assert.equal((await request(path, 'POST', payload)).status, 200);
      assert.equal(wallet.balancePaise, 612345); assert.equal(entries.length, 1); assert.equal(String(entries[0].actor), userId);
      assert.equal((await request(path, 'POST', { ...payload, amountPaise: 12346 })).status, 409);
      assert.equal((await request(path, 'POST', { ...payload, direction: 'debit', amountPaise: 900000, idempotencyKey: 'overdraw-test-key' })).status, 409); assert.equal(wallet.balancePaise, 612345);
      assert.equal((await request(`/api/superadmin/wallets/${otherId}/adjust`, 'POST', payload)).status, 404);
    });
    await t.test('initialization requires confirmation and ledger mutation endpoints do not exist', async () => {
      assert.equal((await request('/api/superadmin/wallets/initialize', 'POST', {})).status, 400);
      assert.equal((await request(`/api/superadmin/wallets/${workspaceId}/entries`, 'DELETE')).status, 404);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [Model, key, original] of originals.reverse()) Model[key] = original;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});
