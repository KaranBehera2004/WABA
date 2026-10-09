import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { businessWallet } from './wallet.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { PlatformSettings } from '../models/Platform.js';
import { TestWallet, WalletConfig, WalletEntry } from '../models/Wallet.js';
import { WALLET_EXPORT_BATCH_SIZE } from '../services/walletExport.js';

test('wallet history download is authenticated, permission-scoped, complete and read-only', async t => {
  const userId = '507f1f77bcf86cd799439011', workspaceId = '507f1f77bcf86cd799439012', otherId = '507f1f77bcf86cd799439013';
  const previousSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'wallet-export-route-test-only';
  const originals = [], filters = [];
  const mock = (Model, key, fn) => { originals.push([Model, key, Model[key]]); Model[key] = fn; };
  const user = { _id: new mongoose.Types.ObjectId(userId), role: 'owner', isActive: true, sessionVersion: 0, defaultWorkspace: workspaceId };
  const workspace = { _id: workspaceId, members: [{ user: user._id, role: 'owner' }], disabledFeatures: [], limits: {} };
  const record = number => ({ _id: number.toString(16).padStart(24, '0'), workspace: workspaceId, kind: 'activity', activity: 'calls', deltaPaise: -500, balanceAfterPaise: 500000 - number * 500, status: 'complete', reason: 'Demo call, "test"', actor: { name: '₹ Test customer' }, createdAt: new Date('2026-10-05T10:00:00Z') });
  let entries = Array.from({ length: WALLET_EXPORT_BATCH_SIZE + 3 }, (_, index) => record(index + 1));
  let readError;
  mock(User, 'findById', async () => user);
  mock(Workspace, 'findOne', async filter => String(filter._id) === workspaceId ? workspace : null);
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => ({ maintenanceEnabled: false }) }));
  mock(WalletEntry, 'find', filter => {
    filters.push(filter);
    const q = {
      populate: (field, projection) => { assert.equal(field, 'actor'); assert.equal(projection, 'name'); return q; },
      sort: order => { assert.deepEqual(order, { _id: -1 }); return q; },
      limit: size => { assert.equal(size, WALLET_EXPORT_BATCH_SIZE); return q; },
      lean: async () => { if (readError) throw readError; return entries.filter(entry => String(entry.workspace) === String(filter.workspace) && (!filter._id || entry._id < String(filter._id.$lt))).sort((a, b) => b._id.localeCompare(a._id)).slice(0, WALLET_EXPORT_BATCH_SIZE); },
    };
    return q;
  });
  const noMutation = () => assert.fail('Exporting wallet history must not initialize, debit, top up or otherwise mutate a business.');
  mock(mongoose, 'startSession', noMutation);
  for (const Model of [Workspace, TestWallet, WalletConfig, WalletEntry]) for (const method of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne']) mock(Model, method, noMutation);
  mock(TestWallet, 'findOne', noMutation); mock(WalletConfig, 'findOne', noMutation);
  const app = express(); app.use(express.json()); app.use('/api/wallet', businessWallet);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (query = '', headers = {}) => fetch(base + '/api/wallet/export' + query, { headers: { Authorization: 'Bearer ' + jwt.sign({ sub: userId, role: 'superadmin', version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' }), ...headers } });
  const jsonError = async (response, status) => { assert.equal(response.status, status); assert.match(response.headers.get('content-type'), /^application\/json/); assert.equal(response.headers.get('content-disposition'), null); return response.json(); };
  try {
    await t.test('authentication and wallet.read are required before any ledger read', async () => {
      await jsonError(await request('', { Authorization: '' }), 401);
      workspace.members[0].role = 'viewer'; workspace.permissionRules = [{ role: 'viewer', permissions: [] }];
      await jsonError(await request(), 403);
      assert.equal(filters.length, 0);
      workspace.members[0].role = 'owner'; workspace.permissionRules = [];
    });
    await t.test('exports all pages using authorized membership rather than query/body workspace or token root claims', async () => {
      const response = await request('?workspace=' + otherId + '&before=bad-id&limit=1');
      assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/csv;\s*charset=utf-8$/i);
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="waba-wallet-transactions-${workspaceId}-${new Date().toISOString().slice(0, 10)}.csv"`);
      assert.match(response.headers.get('cache-control'), /private/); assert.match(response.headers.get('cache-control'), /no-store/);
      const bytes = Buffer.from(await response.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const csv = bytes.toString('utf8');
      assert.equal((csv.match(/"Calls"/g) || []).length, WALLET_EXPORT_BATCH_SIZE + 3);
      assert.ok(csv.includes(',-5.00,')); assert.ok(csv.includes('"₹ Test customer"'));
      assert.ok(csv.includes('"Demo call, ""test"""')); assert.ok(csv.includes('Date (UTC)'));
      assert.equal(filters.length, 2); assert.ok(filters.every(filter => String(filter.workspace) === workspaceId));
      const reads = filters.length; await jsonError(await request('', { 'X-Workspace-Id': otherId }), 403); assert.equal(filters.length, reads);
    });
    await t.test('empty history returns a valid header-only download without funding a wallet', async () => {
      entries = []; const response = await request(); assert.equal(response.status, 200);
      const csv = Buffer.from(await response.arrayBuffer()).toString('utf8'); assert.equal(csv.split('\r\n').length, 2); assert.ok(csv.startsWith('\uFEFF"Date (UTC)"'));
    });
    await t.test('initial database failures or corrupt saved data return JSON before attachment headers', async () => {
      readError = new Error('Test export lookup failed.'); await jsonError(await request(), 500); readError = undefined;
      entries = [{ ...record(1), deltaPaise: NaN }]; await jsonError(await request(), 500);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [Model, key, original] of originals.reverse()) Model[key] = original;
    if (previousSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousSecret;
  }
});
