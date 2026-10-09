import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import router from './superadmin.js';
import workspaceRouter from './workspaces.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, requireWorkspace } from '../middleware/workspace.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { PlatformAnnouncement, PlatformSettings } from '../models/Platform.js';

test('extended admin tools are protected, validated and scope their writes', async t => {
  const userId = '507f1f77bcf86cd799439011', workspaceId = '507f1f77bcf86cd799439012', otherId = '507f1f77bcf86cd799439013';
  const originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'operations-test-secret';
  const mocks = []; const mock = (Model, key, fn) => { mocks.push([Model, key, Model[key]]); Model[key] = fn; };
  let user = { _id: new mongoose.Types.ObjectId(userId), role: 'superadmin', isActive: true, sessionVersion: 0, defaultWorkspace: workspaceId };
  const workspace = { _id: workspaceId, name: 'Test workspace', members: [{ user: user._id, role: 'agent' }], disabledFeatures: [], permissionRules: [], limits: {}, save: async () => {} };
  let userFilter, userUpdates, workspaceFilter, workspaceUpdates, announcementFilter, userSelection;
  mock(User, 'findById', async () => user);
  mock(Workspace, 'findById', async () => workspace);
  mock(Workspace, 'findOne', async () => workspace);
  mock(Workspace, 'countDocuments', async () => 1);
  mock(Workspace, 'updateMany', async (filter, update) => { workspaceFilter = filter; workspaceUpdates = update; return { matchedCount: 1, modifiedCount: 1 }; });
  mock(User, 'updateMany', async (filter, update) => { userFilter = filter; userUpdates = update; return { modifiedCount: 2 }; });
  mock(User, 'findOneAndUpdate', async (filter, update) => { userFilter = filter; userUpdates = update; return { _id: filter._id }; });
  mock(User, 'find', () => { const query = { select: fields => { userSelection = fields; return query; }, sort: () => query, limit: () => query, lean: async () => [{ _id: userId, name: '=DANGEROUS()', email: 'test@example.com', password: 'must-not-export', sessionVersion: 19 }] }; return query; });
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => ({ maintenanceEnabled: false }) }));
  mock(PlatformAnnouncement, 'find', filter => { announcementFilter = filter; const query = { select: () => query, sort: () => query, limit: () => query, lean: async () => [] }; return query; });
  const app = express(); app.use(express.json()); app.use('/api/superadmin', router); app.use('/api/workspaces', workspaceRouter);
  app.post('/api/contacts', requireAuth, requireWorkspace, requireRole('owner', 'admin', 'agent'), (_req, res) => res.json({ granted: true }));
  app.get('/api/contacts', requireAuth, requireWorkspace, (_req, res) => res.json({ granted: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: 'Bearer ' + jwt.sign({ sub: userId, version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' }), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await t.test('ordinary accounts cannot open any new admin tool', async () => {
      for (const role of ['owner', 'admin', 'agent']) {
        user.role = role;
        for (const path of ['/permissions/' + workspaceId, '/usage', '/security', '/monitoring', '/announcements', '/exports/users']) assert.equal((await request('/api/superadmin' + path)).status, 403);
      }
      user.role = 'superadmin';
    });
    await t.test('permission editor receives role ceilings for the selected business', async () => {
      const response = await request('/api/superadmin/permissions/' + workspaceId);
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.workspace._id, workspaceId);
      assert.deepEqual(data.roles, ['admin', 'agent', 'supervisor']);
      assert.ok(data.allowedPermissions.agent.includes('conversations.send'));
      assert.ok(data.allowedPermissions.agent.includes('wallet.read'));
      assert.ok(data.allowedPermissions.agent.includes('integrations.manage'));
      assert.ok(data.allowedPermissions.admin.includes('team.manage'));
    });
    await t.test('permissions and capacities reject malformed or elevated role definitions', async () => {
      assert.equal((await request('/api/superadmin/permissions/' + workspaceId, 'PUT', { rules: [{ role: 'owner', permissions: [] }] })).status, 400);
      assert.equal((await request('/api/superadmin/permissions/' + workspaceId, 'PUT', { rules: [{ role: 'viewer', permissions: ['contacts.read', 'contacts.create'] }] })).status, 400);
      assert.deepEqual(workspace.permissionRules, []);
      assert.equal((await request('/api/superadmin/permissions/' + workspaceId, 'PUT', { rules: [{ role: 'agent', permissions: ['contacts.read', 'contacts.create'] }] })).status, 200);

      assert.equal((await request('/api/superadmin/permissions/' + workspaceId, 'PUT', { rules: [{ role: 'agent', permissions: ['contacts.read'] }] })).status, 200);
      assert.equal((await request('/api/superadmin/usage/' + workspaceId, 'PATCH', { limits: { contacts: -1 } })).status, 400);
      assert.equal((await request('/api/superadmin/usage/' + workspaceId, 'PATCH', { limits: { contacts: 0, members: null } })).status, 200);
    });
    await t.test('Agent custom grants respect the business permission ceiling and revoked reads fail', async () => {
      user.role = 'agent';
      assert.equal((await request('/api/contacts', 'POST', {})).status, 403);
      workspace.permissionRules = [{ role: 'agent', permissions: [] }];
      assert.equal((await request('/api/contacts')).status, 403);
      assert.equal((await request('/api/contacts', 'POST', {})).status, 403);
      assert.equal((await request('/API/CONTACTS/', 'POST', {})).status, 403);
      user.role = 'superadmin';
    });
    await t.test('stored retired memberships remain blocked even with previously granted writes', async () => {
      user.role = 'agent'; workspace.members[0].role = 'viewer'; workspace.permissionRules = [{role:'viewer',permissions:['contacts.read','contacts.create']}];
      assert.equal((await request('/api/contacts')).status,403); assert.equal((await request('/api/contacts','POST',{})).status,403);
      workspace.members[0].role = 'agent'; user.role = 'superadmin';
    });
    await t.test('session revocation excludes self and defaults to protecting other superadmins', async () => {
      assert.equal((await request('/api/superadmin/security/users/' + userId + '/revoke', 'POST', {})).status, 400);
      assert.equal((await request('/api/superadmin/security/revoke-others', 'POST', {})).status, 400);
      assert.equal((await request('/api/superadmin/security/revoke-others', 'POST', { confirmation: 'REVOKE OTHER SESSIONS' })).status, 200);
      assert.equal(String(userFilter._id.$ne), userId); assert.deepEqual(userFilter.role, { $ne: 'superadmin' }); assert.equal(userUpdates.$inc.sessionVersion, 1);
      assert.equal((await request('/api/superadmin/security/users/' + otherId + '/revoke', 'POST', {})).status, 200); assert.deepEqual(userFilter, { _id: otherId, deletedAt: null });
    });
    await t.test('bulk workspace controls require confirmation, distinct IDs and valid actions', async () => {
      const body = { ids: [workspaceId], action: 'pauseSending', confirmation: 'APPLY TO SELECTED WORKSPACES' };
      assert.equal((await request('/api/superadmin/workspaces/bulk-control', 'POST', { ...body, confirmation: '' })).status, 400);
      assert.equal((await request('/api/superadmin/workspaces/bulk-control', 'POST', { ...body, ids: [workspaceId, workspaceId] })).status, 400);
      assert.equal((await request('/api/superadmin/workspaces/bulk-control', 'POST', { ...body, action: 'deleteEverything' })).status, 400);
      assert.equal((await request('/api/superadmin/workspaces/bulk-control', 'POST', body)).status, 200);
      assert.deepEqual(workspaceFilter._id.$in, [workspaceId]); assert.deepEqual(workspaceUpdates.$set, { sendingEnabled: false });
    });
    await t.test('CSV exports omit password/session secrets and neutralize spreadsheet formulas', async () => {
      const response = await request('/api/superadmin/exports/users'); assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(!userSelection.includes('password')); assert.ok(!userSelection.includes('sessionVersion')); assert.ok(!body.content.includes('must-not-export')); assert.ok(body.content.includes("'=DANGEROUS()"));
      assert.equal((await request('/api/superadmin/exports/messages')).status, 400);
      assert.equal((await request('/api/superadmin/exports/__proto__')).status, 404);
    });
    await t.test('announcement dates and target workspaces are validated before creation', async () => {
      assert.equal((await request('/api/superadmin/announcements', 'POST', { title: 'Test', message: 'Test', startsAt: 'not-a-date' })).status, 400);
      assert.equal((await request('/api/superadmin/announcements', 'POST', { title: 'Test', message: 'Test', startsAt: '2026-01-02', endsAt: '2026-01-01' })).status, 400);
      assert.equal((await request('/api/superadmin/announcements', 'POST', { audience: 'Selected workspaces', workspaces: [] })).status, 400);
      assert.equal((await request('/api/workspaces/current/announcements')).status, 200);
      assert.equal(announcementFilter.isActive, true); assert.equal(announcementFilter.$and[0].$or[1].workspaces, workspaceId); assert.ok(announcementFilter.$and[2].$or[1].endsAt.$gt instanceof Date);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [Model, key, fn] of mocks.reverse()) Model[key] = fn;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  }
});
