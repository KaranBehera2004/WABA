import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { Campaign, Conversation, CallLog } from '../models/Domain.js';
import { PlatformSettings } from '../models/Platform.js';
import { executeAdminDeletion, previewAdminDeletion, validateDeletionSelection, verifyDeletionRequest } from './adminDeletion.js';

const id = n => n.toString(16).padStart(24, '0');
const matches = (item, filter) => Object.entries(filter).every(([key, expected]) => {
  const values = key === 'members.user' ? (item.members || []).map(member => member.user) : [item[key]];
  if (expected === null) return values.some(value => value == null);
  if (expected?.$in) return values.some(value => expected.$in.map(String).includes(String(value)));
  if (expected?.$nin) return values.every(value => !expected.$nin.map(String).includes(String(value)));
  return values.some(value => String(value) === String(expected));
});
const query = read => ({ select() { return this; }, sort() { return this; }, limit() { return this; }, session() { return this; }, lean: async () => structuredClone(read()), then(resolve, reject) { return Promise.resolve(read()).then(resolve, reject); } });

test('deletion snapshots are bounded, protected, atomic and history-preserving without a live database', async t => {
  const originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'deletion-unit-tests-only';
  const mocks = []; const mock = (object, key, fn) => { mocks.push([object, key, object[key]]); object[key] = fn; };
  const actor = { _id: id(1), name: 'Root', role: 'superadmin', isActive: true, sessionVersion: 0 };
  let users, workspaces, campaigns, conversations, calls, failure = false, ended = 0;
  const reset = () => {
    users = [{ ...actor }, { _id: id(2), name: 'Owner', isActive: true, role: 'owner', defaultWorkspace: id(10) }, { _id: id(3), name: 'Agent', isActive: true, role: 'agent', sessionVersion: 0, defaultWorkspace: id(10) }];
    workspaces = [{ _id: id(10), name: 'Business', owner: id(2), isActive: true, sendingEnabled: true, members: [{ user: id(2), role: 'owner' }, { user: id(3), role: 'agent' }] }];
    campaigns = [{ workspace: id(10), status: 'Running' }]; conversations = [{ assignedTo: id(3), body: 'History remains' }]; calls = [{ assignedTo: id(3) }];
  };
  reset();
  const mutate = (items, filter, update) => {
    let modifiedCount = 0;
    for (const item of items.filter(item => matches(item, filter))) {
      Object.assign(item, update.$set || {});
      for (const key of Object.keys(update.$unset || {})) delete item[key];
      for (const [key, value] of Object.entries(update.$inc || {})) item[key] = (item[key] || 0) + value;
      if (update.$pull?.members) item.members = item.members.filter(member => !matches(member, update.$pull.members));
      modifiedCount++;
    }
    return { matchedCount: modifiedCount, modifiedCount };
  };
  mock(User, 'find', filter => query(() => users.filter(item => matches(item, filter))));
  mock(User, 'findById', key => query(() => users.find(item => item._id === String(key))));
  mock(Workspace, 'find', filter => query(() => workspaces.filter(item => matches(item, filter))));
  mock(Workspace, 'findOne', filter => query(() => workspaces.find(item => matches(item, filter)) || null));
  mock(User, 'updateMany', async (filter, update) => mutate(users, filter, update));
  mock(User, 'updateOne', async (filter, update) => mutate(users, filter, update));
  mock(Workspace, 'updateMany', async (filter, update) => { if (failure) throw new Error('Simulated failure'); return mutate(workspaces, filter, update); });
  mock(Campaign, 'updateMany', async (filter, update) => mutate(campaigns, filter, update));
  mock(Conversation, 'updateMany', async (filter, update) => mutate(conversations, filter, update));
  mock(CallLog, 'updateMany', async (filter, update) => mutate(calls, filter, update));
  mock(PlatformSettings, 'findOneAndUpdate', async () => ({}));
  mock(mongoose, 'startSession', async () => ({ endSession: async () => { ended++; }, withTransaction: async fn => {
    const before = structuredClone({ users, workspaces, campaigns, conversations, calls });
    try { await fn(); } catch (error) { ({ users, workspaces, campaigns, conversations, calls } = before); throw error; }
  } }));
  const preview = (resource = 'users') => previewAdminDeletion({ resource, scope: 'all' }, actor);
  const execute = value => executeAdminDeletion({ token: value.token, confirmation: value.confirmation }, actor);
  try {
    await t.test('selected requests reject duplicate, invalid, empty and excessive IDs', () => {
      for (const ids of [[], ['bad'], [id(3), id(3)], Array.from({ length: 201 }, (_, n) => id(n + 1))]) assert.throws(() => validateDeletionSelection({ resource: 'users', scope: 'selected', ids }));
      assert.throws(() => validateDeletionSelection({ resource: 'users', scope: 'all', ids: [] }));
      assert.throws(() => validateDeletionSelection({ resource: 'wallets', scope: 'all' }));
    });
    await t.test('preview does not mutate; current root and undeleted workspace owner are protected', async () => {
      const before = structuredClone(users); const value = await preview();
      assert.deepEqual(value.targets.map(item => item.id), [id(3)]); assert.equal(value.protected.length, 2); assert.deepEqual(users, before);
      assert.throws(() => verifyDeletionRequest({ token: value.token, confirmation: 'delete users' }, actor));
      assert.throws(() => verifyDeletionRequest({ token: value.token, confirmation: value.confirmation, ids: [id(1)] }, actor));
      assert.throws(() => verifyDeletionRequest({ token: value.token, confirmation: value.confirmation }, { ...actor, _id: id(4) }));
      assert.throws(() => verifyDeletionRequest({ token: value.token, confirmation: value.confirmation }, { ...actor, sessionVersion: 1 }));
      assert.throws(() => verifyDeletionRequest({ token: jwt.sign({ actor: actor._id }, process.env.JWT_SECRET), confirmation: value.confirmation }, actor));
    });
    await t.test('user deletion revokes sessions and memberships, retains records, excludes newly-created accounts and is idempotent', async () => {
      reset(); const value = await preview(); users.push({ _id: id(4), name: 'Later', isActive: true, role: 'agent' });
      const result = await execute(value); assert.equal(result.deletedCount, 1); assert.equal(result.protectedCount, 2);
      assert.equal(users[2].isActive, false); assert.equal(users[2].sessionVersion, 1); assert.ok(users[2].deletedAt);
      assert.equal(users[3].deletedAt, undefined); assert.equal(workspaces[0].members.length, 1);
      assert.equal(conversations[0].assignedTo, undefined); assert.equal(conversations[0].body, 'History remains');
      const repeat = await execute(value); assert.equal(repeat.deletedCount, 0); assert.equal(repeat.alreadyDeletedCount, 1);
    });
    await t.test('originally protected records remain protected after ownership changes', async () => {
      reset(); const value = await preview(); workspaces[0].owner = id(4);
      await execute(value); assert.equal(users[1].deletedAt, undefined);
    });
    await t.test('new owners are rechecked and skipped even if eligible in preview', async () => {
      reset(); const value = await preview(); workspaces[0].owner = id(3);
      const result = await execute(value); assert.equal(result.deletedCount, 0); assert.equal(result.protectedCount, 3);
    });
    await t.test('workspace archive pauses campaigns, blocks automatic recreation and does not delete user accounts', async () => {
      reset(); const value = await preview('workspaces'); const result = await execute(value);
      assert.equal(result.deletedCount, 1); assert.equal(workspaces[0].sendingEnabled, false); assert.ok(workspaces[0].deletedAt);
      assert.equal(campaigns[0].status, 'Paused'); assert.equal(users[1].defaultWorkspace, undefined); assert.equal(users[1].autoWorkspaceCreationBlocked, true); assert.equal(users[1].isActive, true);
      assert.equal(conversations.length, 1);
    });
    await t.test('transaction failures roll back all changes and release the session', async () => {
      reset(); const value = await preview(); failure = true; const before = ended;
      await assert.rejects(execute(value), /Simulated failure/); failure = false;
      assert.equal(users[2].deletedAt, undefined); assert.equal(users[2].isActive, true); assert.equal(ended, before + 1);
    });
    await t.test('large delete-all requests fail explicitly rather than truncating targets', async () => {
      reset(); workspaces = Array.from({ length: 1001 }, (_, n) => ({ _id: id(n + 10), name: 'Business' }));
      await assert.rejects(preview('workspaces'), /1000/);
    });
  } finally {
    for (const [object, key, original] of mocks.reverse()) object[key] = original;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  }
});
