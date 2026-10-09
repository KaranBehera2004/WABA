import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import router from './superadmin.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { Conversation } from '../models/Domain.js';
import { PlatformSettings } from '../models/Platform.js';
import { mergeManagedMembers } from '../services/superadminManagement.js';

test('workspace management preserves routing and disabled legacy memberships', () => {
  const previous = new Workspace({ members: [{ user: '507f1f77bcf86cd799439011', role: 'viewer', disabled: true, capacity: 5, availability: 'away', teams: ['507f1f77bcf86cd799439012'], allowedNumbers: ['507f1f77bcf86cd799439013'], visibility: 'teams', canClaim: true }] }).members;
  const result = mergeManagedMembers(previous, [{ user: String(previous[0].user), role: 'agent' }]);
  assert.equal(result[0].disabled, true); assert.equal(result[0].capacity, 5); assert.equal(result[0].availability, 'away');
  assert.equal(result[0].visibility, 'teams'); assert.equal(result[0].canClaim, true);
  assert.deepEqual(result[0].teams, previous[0].teams); assert.deepEqual(result[0].allowedNumbers, previous[0].allowedNumbers);
  assert.equal(mergeManagedMembers(previous, [{ user: String(previous[0].user), role: 'agent', disabled: false }])[0].disabled, false);
});

test('workspace management validates scope and protects account access', async t => {
  const actorId = '507f1f77bcf86cd799439011', workspaceId = '507f1f77bcf86cd799439012', targetId = '507f1f77bcf86cd799439013';
  const secret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'management-test-only';
  const originals = []; const mock = (object, key, value) => { originals.push([object, key, object[key]]); object[key] = value; };
  const query = value => { const q = { select: fields => { selections.push(fields); return q; }, populate: () => q, lean: () => q, session: () => q, sort: () => q, then: (resolve, reject) => Promise.resolve(typeof value === 'function' ? value() : value).then(resolve, reject) }; return q; };
  let selections = [], saved = 0, revoked = 0, locks = 0, chatUpdates = [], scopeMatches = true, lastAdmin = true, memberWrites = false, membershipRevocations = [];
  const actor = { _id: actorId, role: 'superadmin', isActive: true, sessionVersion: 0 };
  const target = { _id: targetId, name: 'Business owner', email: 'owner@example.test', role: 'owner', isActive: true, sessionVersion: 0, save: async () => { saved++; }, toSafeObject: () => ({ id: targetId }) };
  const workspace = new Workspace({ _id: workspaceId, owner: targetId, name: 'Business', members: [{ user: targetId, role: 'owner' }, { user: actorId, role: 'admin' }] });
  mock(User, 'findById', id => query(String(id) === actorId ? actor : target));
  mock(Workspace, 'findOne', filter => query(filter['members.user'] && !scopeMatches ? null : workspace));
  mock(Workspace, 'find', () => query([workspace]));
  mock(Workspace, 'findById', () => query(workspace));
  workspace.save = async () => {};
  mock(Workspace, 'updateOne', async () => { locks++; });
  mock(User, 'find', filter => query(filter.isActive ? (lastAdmin ? [{ _id: targetId }] : [{ _id: targetId }, { _id: actorId }]) : memberWrites ? [target, actor] : [{ _id: targetId, name: target.name, email: target.email, isActive: true }]));
  mock(User, 'updateMany', async (filter, update) => { membershipRevocations.push({ filter, update }); });
  mock(User, 'findOneAndUpdate', async () => { revoked++; return target; });
  mock(Conversation, 'updateMany', async (filter, update) => { chatUpdates.push({ filter, update }); });
  mock(PlatformSettings, 'findOne', () => query({ passwordMinLength: 12, passwordRequireUppercase: true, passwordRequireNumber: true }));
  mock(PlatformSettings, 'findOneAndUpdate', async () => ({}));
  mock(mongoose, 'startSession', async () => ({ withTransaction: async callback => callback(), endSession: async () => {} }));
  const app = express(); app.use(express.json()); app.use('/api/superadmin', router); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = (path, method = 'GET', body, authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/api/superadmin${path}`, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + jwt.sign({ sub: actorId, version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' }) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await t.test('only authenticated platform superadmins can manage or reset', async () => {
      assert.equal((await request(`/workspaces/${workspaceId}/manage`, 'GET', undefined, false)).status, 401);
      actor.role = 'agent';
      assert.equal((await request(`/workspaces/${workspaceId}/manage`)).status, 403);
      assert.equal((await request(`/users/${targetId}/reset-password`, 'POST', { workspace: workspaceId, password: 'ExamplePassword12' })).status, 403);
      actor.role = 'superadmin'; assert.equal(saved, 0);
    });
    await t.test('member details expose policy and safe account fields only', async () => {
      const response = await request(`/workspaces/${workspaceId}/manage`); assert.equal(response.status, 200);
      const data = await response.json(); assert.equal(data.users.length, 1); assert.equal(data.passwordPolicy.minLength, 12);
      assert.equal(data.users[0].password, undefined); assert.equal(data.users[0].sessionVersion, undefined);
      assert.ok(selections.includes('name email company role isActive lastLoginAt'));
      assert.equal((await request('/workspaces/invalid/manage')).status, 400);
    });
    await t.test('wrong business context rejects password, account and session writes', async () => {
      scopeMatches = false;
      for (const [path, method, body] of [[`/users/${targetId}/reset-password`, 'POST', { password: 'ExamplePassword12' }], [`/users/${targetId}`, 'PATCH', { name: 'Changed' }], [`/security/users/${targetId}/revoke`, 'POST', {}]]) {
        assert.equal((await request(path, method, { ...body, workspace: workspaceId })).status, 404);
      }
      scopeMatches = true; assert.equal(saved, 0); assert.equal(revoked, 0);
      assert.equal((await request(`/users/${targetId}/reset-password`, 'POST', { workspace: 'invalid', password: 'ExamplePassword12' })).status, 400);
    });
    await t.test('password reset enforces policy and revokes existing login tokens', async () => {
      for (const password of ['short', 'lowercaseonly12', 'UppercaseWithoutNumber']) assert.equal((await request(`/users/${targetId}/reset-password`, 'POST', { workspace: workspaceId, password })).status, 400);
      assert.equal(saved, 0);
      const response = await request(`/users/${targetId}/reset-password`, 'POST', { workspace: workspaceId, password: 'ExamplePassword12' });
      assert.equal(response.status, 200); assert.equal(target.sessionVersion, 1); assert.equal(saved, 1);
      assert.ok(!(await response.text()).includes('ExamplePassword12'));
    });
    await t.test('last active business admin is protected from global disabling', async () => {
      const response = await request(`/users/${targetId}`, 'PATCH', { workspace: workspaceId, isActive: false });
      assert.equal(response.status, 409); assert.equal(target.isActive, true); assert.equal(saved, 1); assert.equal(locks, 1); assert.equal(chatUpdates.length, 0);
    });
    await t.test('disabling with another active admin revokes sessions and releases open chats', async () => {
      lastAdmin = false;
      assert.equal((await request(`/users/${targetId}`, 'PATCH', { workspace: workspaceId, isActive: false })).status, 200);
      assert.equal(target.isActive, false); assert.equal(target.sessionVersion, 2);
      assert.deepEqual(chatUpdates[0], { filter: { assignedTo: targetId, status: { $ne: 'closed' } }, update: { $set: { assignedTo: null }, $inc: { version: 1 } } });
    });
    await t.test('Viewer and malformed business access are rejected before membership writes', async () => {
      assert.equal((await request(`/workspaces/${workspaceId}/members`, 'PUT', { owner: targetId, members: [{ user: targetId, role: 'viewer' }] })).status, 400);
      assert.equal((await request(`/workspaces/${workspaceId}/members`, 'PUT', { owner: targetId, members: [{ user: targetId, role: 'owner', disabled: 'false' }] })).status, 400);
      assert.equal((await request(`/workspaces/${workspaceId}/members`, 'PUT', { owner: targetId, members: [null] })).status, 400);
    });
    await t.test('member access edits preserve routing and revoke disabled users while releasing chats', async () => {
      memberWrites = true; target.isActive = true; target.defaultWorkspace = workspaceId; actor.defaultWorkspace = workspaceId;
      workspace.members[1].role = 'agent'; workspace.members[1].capacity = 7; workspace.members[1].availability = 'away'; workspace.members[1].visibility = 'teams'; workspace.members[1].teams = [workspaceId]; workspace.members[1].allowedNumbers = [workspaceId]; workspace.members[1].canClaim = true;
      const response = await request(`/workspaces/${workspaceId}/members`, 'PUT', { owner: targetId, members: [{ user: targetId, role: 'owner' }, { user: actorId, role: 'agent', disabled: true }] });
      assert.equal(response.status, 200); assert.equal(workspace.members[1].disabled, true); assert.equal(workspace.members[1].capacity, 7); assert.equal(workspace.members[1].visibility, 'teams'); assert.equal(workspace.members[1].availability, 'away'); assert.equal(workspace.members[1].canClaim, true);
      assert.equal(String(workspace.members[1].teams[0]), workspaceId); assert.equal(String(workspace.members[1].allowedNumbers[0]), workspaceId);
      assert.deepEqual(membershipRevocations[0].update, { $inc: { sessionVersion: 1 } });
      assert.equal(chatUpdates[1].filter.workspace, workspace._id); assert.equal(chatUpdates[1].update.$inc.version, 1);
    });
    await t.test('the designated business owner cannot have disabled workspace access', async () => {
      const response = await request(`/workspaces/${workspaceId}/members`, 'PUT', { owner: targetId, members: [{ user: targetId, role: 'owner', disabled: true }, { user: actorId, role: 'agent', disabled: true }] });
      assert.equal(response.status, 409); assert.equal(workspace.members[0].disabled, false);
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [object, key, original] of originals.reverse()) object[key] = original;
    if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
  }
});
