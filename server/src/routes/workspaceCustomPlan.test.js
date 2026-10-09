import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import router from './superadmin.js';
import User from '../models/User.js';
import Workspace from '../models/Workspace.js';
import { PlatformPlan, PlatformSettings, AdminAudit } from '../models/Platform.js';
import { auditAdminChanges } from '../middleware/superadmin.js';
import { WalletConfig } from '../models/Wallet.js';
import { ACTIVITY_PRICES } from '../services/walletConfig.js';

test('custom plan endpoints restrict writes to one workspace and preserve platform defaults', async t => {
  const actorId = '507f1f77bcf86cd799439011', firstId = '507f1f77bcf86cd799439012', secondId = '507f1f77bcf86cd799439013', planId = '507f1f77bcf86cd799439014';
  const beforeSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = 'custom-plan-tests-only';
  const mocks = []; const mock = (object, key, value) => { mocks.push([object, key, object[key]]); object[key] = value; };
  const actor = { _id: actorId, role: 'superadmin', isActive: true, sessionVersion: 0 };
  const standard = { _id: planId, name: 'Standard', monthlyPrice: 1999, currency: 'INR', features: ['contacts','conversations'], limits: { contacts: 1000 } };
  const settings = { defaultPlan: planId };
  const workspaces = new Map([firstId, secondId].map(id => [id, { _id: id, name: 'Business', plan: planId, capacityVersion: 0, limits: {} }]));
  let writes = 0, audits = [];
  const proposal = { name: 'Negotiated Enterprise', monthlyPrice: 1299, currency: 'INR', features: ['contacts'], limits: { contacts: 250 } };
  mock(User, 'findById', async () => actor);
  mock(PlatformSettings, 'findOne', () => ({ lean: async () => settings }));
  mock(WalletConfig, 'findOne', () => ({ lean: async () => ({ prices: { ...ACTIVITY_PRICES } }) }));
  mock(WalletConfig, 'findOneAndUpdate', () => assert.fail('Custom business pricing must never change platform prices.'));
  mock(PlatformPlan, 'findById', () => ({ lean: async () => standard }));
  mock(PlatformPlan, 'findByIdAndUpdate', () => assert.fail('A custom plan must never change a catalogue plan.'));
  mock(PlatformSettings, 'findOneAndUpdate', () => assert.fail('A business custom plan must never change the default plan.'));
  mock(AdminAudit, 'create', async item => { audits.push(item); });
  mock(Workspace, 'findOne', filter => ({ populate: () => ({ lean: async () => { const item = workspaces.get(filter._id); return item && { ...item, plan: standard }; } }) }));
  mock(Workspace, 'findOneAndUpdate', async (filter, update, options) => {
    assert.equal(filter.deletedAt, null); assert.equal(options.new, true);
    const workspace = workspaces.get(filter._id); if (!workspace) return null;
    writes++; if (update.$set) { assert.equal(options.runValidators, true); workspace.customPlan ||= {}; for(const [key,value]of Object.entries(update.$set))workspace.customPlan[key.replace('customPlan.','')]=value; }
    if (update.$unset) delete workspace.customPlan;
    workspace.capacityVersion += update.$inc.capacityVersion; return workspace;
  });
  const app = express(); app.use(express.json()); app.use(auditAdminChanges); app.use('/api/superadmin', router); app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const request = (id, method = 'GET', body, suffix = '', authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/api/superadmin/workspaces/${id}/custom-plan${suffix}`, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + jwt.sign({ sub: actorId, version: 0 }, process.env.JWT_SECRET, { issuer: 'waba-api' }) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await t.test('only platform Super Admin can read, apply or restore negotiated plans', async () => {
      assert.equal((await request(firstId,'GET',undefined,'',false)).status,401);
      for (const role of ['admin','agent']) { actor.role = role; for (const [method, body, suffix] of [['GET',undefined,''],['PUT',proposal,''],['POST',{confirm:true},'/restore']]) assert.equal((await request(firstId,method,body,suffix)).status,403); }
      actor.role = 'superadmin'; assert.equal(writes,0);
    });
    await t.test('invalid data and absent/deleted workspace targets cannot be saved', async () => {
      assert.equal((await request(firstId,'PUT',{...proposal,monthlyPrice:-1})).status,400);
      assert.equal((await request('invalid','PUT',proposal)).status,400);
      assert.equal((await request('507f1f77bcf86cd799439099','PUT',proposal)).status,404); assert.equal(writes,0);
    });
    await t.test('custom plan is atomic, workspace-specific and audited', async () => {
      const response = await request(firstId,'PUT',{...proposal,workspace:secondId,updatedBy:secondId}); assert.equal(response.status,200);
      assert.equal(writes,1); assert.equal(workspaces.get(firstId).customPlan.monthlyPrice,1299); assert.equal(workspaces.get(firstId).customPlan.updatedBy,actorId); assert.equal(workspaces.get(firstId).capacityVersion,1);
      assert.equal(workspaces.get(firstId).plan,planId); assert.equal(workspaces.get(secondId).customPlan,undefined);
      assert.equal(settings.defaultPlan,planId); assert.equal(standard.monthlyPrice,1999);
      const first = await (await request(firstId)).json(); const second = await (await request(secondId)).json();
      assert.equal(first.effectivePlan.name,proposal.name); assert.equal(first.basePlan.name,'Standard'); assert.equal(second.effectivePlan.name,'Standard'); assert.equal(second.customPlan,null);
      assert.equal(audits[0].workspace,firstId); assert.equal(audits[0].details.monthlyPrice,1299);
    });
    await t.test('restoring requires confirmation and reinstates only this business standard plan', async () => {
      assert.equal((await request(firstId,'POST',{},'/restore')).status,400); assert.equal(writes,1);
      assert.equal((await request(firstId,'POST',{confirm:true},'/restore')).status,200);
      const configuration = await (await request(firstId)).json(); assert.equal(configuration.customPlan,null); assert.equal(configuration.effectivePlan.name,'Standard'); assert.equal(workspaces.get(firstId).plan,planId); assert.equal(workspaces.get(secondId).plan,planId); assert.equal(settings.defaultPlan,planId);
    });
    await t.test('custom activity pricing is scoped, validated, persisted and preserved by older plan edits',async()=>{
      for(const prices of [{messages:-1},{messages:1.5},{messages:1000001},{messages:'10'},{unknown:10},[]])assert.equal((await request(firstId,'PUT',{...proposal,activityPricesPaise:prices})).status,400);
      assert.equal((await request(firstId,'PUT',{...proposal,activityPricesPaise:{messages:20,contacts:0}})).status,200);
      let first=await(await request(firstId)).json(),second=await(await request(secondId)).json();assert.equal(first.activityPricing.source,'custom');assert.equal(first.activityPricing.pricesPaise.messages,20);assert.equal(first.activityPricing.pricesPaise.contacts,0);assert.equal(second.activityPricing.pricesPaise.messages,75);assert.equal(second.activityPricing.source,'default');
      assert.equal((await request(firstId,'PUT',{...proposal,monthlyPrice:1500})).status,200);first=await(await request(firstId)).json();assert.equal(first.activityPricing.pricesPaise.messages,20);
      assert.equal((await request(firstId,'POST',{confirm:true},'/restore')).status,200);first=await(await request(firstId)).json();assert.equal(first.activityPricing.pricesPaise.messages,75);assert.equal(first.activityPricing.source,'default');
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const [object,key,original] of mocks.reverse()) object[key] = original; if (beforeSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = beforeSecret; }
});
