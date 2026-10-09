import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import workspaceRouter from './workspaces.js';
import dataRouter from './data.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { PlatformSettings } from '../models/Platform.js';
import { CallLog, Campaign, Contact, Conversation, Message, MessageTemplate } from '../models/Domain.js';

test('role dashboards use workspace membership and tenant-scoped, permission-aware agent workload', async t => {
  const userId = new mongoose.Types.ObjectId(), workspaceId = new mongoose.Types.ObjectId();
  const originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'role-dashboard-test-only';
  const user = { _id: userId, role: 'owner', isActive: true, sessionVersion: 0, defaultWorkspace: workspaceId };
  const workspace = { _id: workspaceId, name: 'Business', members: [{ user: userId, role: 'agent' }], permissionRules: [], disabledFeatures: [] };
  const mocks = []; const mock = (target, key, fn) => { mocks.push([target,key,target[key]]); target[key] = fn; };
  const filters = [];
  const query = rows => { const q = { select: () => q, populate: () => q, sort: () => q, limit: () => q, lean: async () => rows, then: (resolve,reject) => Promise.resolve(rows).then(resolve,reject) }; return q; };
  mock(User, 'findById', async () => user);
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => ({}) }));
  mock(Workspace, 'findOne', async filter => {
    assert.equal(String(filter._id), String(workspaceId));
    assert.equal(String(filter['members.user']), String(userId));
    return workspace;
  });
  mock(Workspace, 'findById', () => ({ populate: async () => ({ ...workspace, members: [...workspace.members] }) }));
  mock(Contact, 'countDocuments', async () => 20);
  mock(Contact, 'find', () => query([]));
  mock(Conversation, 'distinct', async (_field,filter) => { assert.equal(String(filter.workspace),String(workspaceId)); return []; });
  mock(Message, 'find', () => query([]));
  mock(MessageTemplate, 'find', () => query([]));
  mock(Campaign, 'find', () => query([]));
  mock(Conversation, 'countDocuments', async filter => { filters.push(['conversation',filter]); return filter.status === 'open' ? 12 : filter.status === 'awaiting_reply' ? 4 : filter.status === 'closed' ? 38 : filter.assignedTo === null ? 7 : 61; });
  mock(Conversation, 'findOne', async filter => { assert.equal(String(filter.workspace), String(workspaceId)); assert.ok(filter.$and, 'Agent record access must be scoped'); return null; });
  mock(Conversation, 'find', filter => { filters.push(['queue',filter]); return query(filter.assignedTo ? [{ _id: 'assigned', contact: { name: 'My customer' }, status: 'open' }] : []); });
  mock(CallLog, 'countDocuments', async filter => { filters.push(['callback',filter]); return 3; });
  let updates = 0;
  mock(Conversation, 'findOneAndUpdate', async filter => { updates++; assert.equal(String(filter.workspace), String(workspaceId)); return { _id: filter._id, status: 'closed' }; });
  const app = express(); app.use(express.json()); app.use('/api/workspaces', workspaceRouter); app.use('/api', dataRouter);
  app.use((error,_req,res,_next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  const request = (path, method = 'GET', body) => fetch('http://127.0.0.1:' + server.address().port + '/api' + path, { method, headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + jwt.sign({ sub: String(userId), version: 0 }, process.env.JWT_SECRET, { issuer:'waba-api' }) }, body: body ? JSON.stringify(body) : undefined });
  try {
    await t.test('membership role remains available even when the team directory is hidden', async () => {
      const response = await request('/workspaces/current'); assert.equal(response.status,200);
      const body = await response.json(); assert.equal(body.membershipRole,'agent'); assert.deepEqual(body.workspace.members,[]);
      assert.equal(body.customPermissions,false); assert.ok(body.permissions.includes('conversations.send')); assert.ok(!body.permissions.includes('campaigns.read'));
    });
    await t.test('agent counts and queue use the current user and workspace, not a client role claim', async () => {
      filters.length = 0;
      const response = await request('/overview?days=7'); assert.equal(response.status,200);
      const body = await response.json(); assert.deepEqual({ ...body.workload, queue: undefined }, { open:12, awaitingReply:4, closed:38, unassigned:0, callbacks:3, queue:undefined, unassignedQueue:[] });
      assert.equal(body.workload.queue[0]._id,'assigned');
      for (const [kind,filter] of filters) {
        assert.equal(String(filter.workspace),String(workspaceId),kind);
        if (kind === 'callback' || kind === 'queue' && filter.assignedTo || ['open','awaiting_reply','closed'].includes(filter.status)) assert.equal(String(filter.assignedTo),String(userId),kind);
      }
    });
    await t.test('disabled modules and permission overrides do not leak workload details', async () => {
      workspace.disabledFeatures = ['calls','contacts']; filters.length = 0;
      const body = await (await request('/overview')).json(); assert.equal(body.workload.callbacks,0); assert.deepEqual(body.workload.queue,[]);
      assert.equal(filters.some(([kind]) => kind === 'callback' || kind === 'queue'),false);
      workspace.disabledFeatures = []; workspace.permissionRules = [{ role:'agent', permissions:['overview.read'] }]; filters.length = 0;
      const restricted = await (await request('/overview')).json(); assert.deepEqual(restricted.workload,{ open:0,awaitingReply:0,closed:0,unassigned:0,callbacks:0,queue:[],unassignedQueue:[] }); assert.equal(filters.length,0);
      workspace.permissionRules = [];
    });
    await t.test('default agent cannot use admin campaign tools; viewer cannot update conversations', async () => {
      assert.equal((await request('/campaigns')).status,403);
      assert.equal((await request('/campaigns','POST',{name:'No'})).status,403);
      workspace.members[0].role = 'viewer';
      assert.equal((await request('/conversations/' + userId,'PATCH',{status:'closed'})).status,403);
      assert.equal(updates,0);
      assert.equal((await request('/conversations/' + userId + '/messages','POST',{})).status,403);
      assert.equal((await request('/overview')).status,403);
      assert.equal((await request('/workspaces/current')).status,403);
    });
    await t.test('business admin access and explicit custom permissions still work', async () => {
      workspace.members[0].role = 'admin'; assert.equal((await request('/campaigns')).status,200);
      assert.equal((await (await request('/overview')).json()).workload,null);
      workspace.members[0].role = 'viewer'; workspace.permissionRules = [{role:'viewer',permissions:['conversations.update','overview.read']}];
      assert.equal((await request('/workspaces/current')).status,403);
      assert.equal((await request('/conversations/' + userId,'PATCH',{status:'closed'})).status,403);
      workspace.members[0].role = 'agent'; workspace.permissionRules = [{role:'agent',permissions:['conversations.update']}];
      const customized = await (await request('/workspaces/current')).json(); assert.equal(customized.customPermissions,true); assert.equal(customized.membershipRole,'agent');
      assert.equal((await request('/conversations/' + userId,'PATCH',{status:'closed'})).status,404);
      assert.equal(updates,0, 'A capability grant never bypasses conversation ownership');
    });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const [target,key,original] of mocks.reverse()) target[key]=original;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
  }
});
