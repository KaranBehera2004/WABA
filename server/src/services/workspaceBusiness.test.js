import test from 'node:test';
import assert from 'node:assert/strict';
import { PlatformPlan } from '../models/Platform.js';
import { workspaceFeatures } from './platform.js';
import { effectiveSeatLimits, membershipCapacityFilter, seatUsage, validateSeatLimits } from './accessControl.js';

test('add-on entitlements expand plan access but never override tenant or platform restrictions', async () => {
  const original = PlatformPlan.findById;
  PlatformPlan.findById = () => ({ lean: async () => ({ features: ['contacts', 'team'] }) });
  try {
    assert.deepEqual(await workspaceFeatures({ plan: 'plan', addonFeatures: ['campaigns', 'contacts', 'automations', 'ivr'], disabledFeatures: ['automations'] }, { disabledFeatures: ['team'] }), ['contacts', 'campaigns']);
    assert.deepEqual(await workspaceFeatures({ plan: 'plan', addonFeatures: [], disabledFeatures: [] }, { disabledFeatures: [] }), ['contacts', 'team']);
    assert.deepEqual(await workspaceFeatures({ plan: 'plan', addonFeatures: ['campaigns'], disabledFeatures: ['campaigns'] }, { disabledFeatures: [] }), ['contacts', 'team']);
  } finally { PlatformPlan.findById = original; }
});

test('role seats are independently unlimited by default and exclude workspace owners', () => {
  const workspace = { members: [{ role: 'owner' }, { role: 'admin' }, { role: 'agent' }, { role: 'agent' }], seatLimits: { admin: 0, viewer: 2 } };
  assert.deepEqual(effectiveSeatLimits(workspace), { admin: 0, agent: null, supervisor: null });
  assert.deepEqual(seatUsage(workspace), { admin: 1, agent: 2, supervisor: 0 });
  assert.deepEqual(effectiveSeatLimits({}), { admin: null, agent: null, supervisor: null });
  assert.equal(validateSeatLimits({ agent: null }), true); assert.equal(validateSeatLimits({ viewer: 2 }), false); assert.equal(validateSeatLimits({ owner: 2 }), false);
});

test('membership updates combine live per-role ceiling with total quota, and only root bypasses both', () => {
  const filter = membershipCapacityFilter('workspace', 'member', 'agent', { members: 4 });
  assert.equal(filter._id, 'workspace'); assert.deepEqual(filter['members.user'], { $ne: 'member' });
  assert.deepEqual(filter.$expr.$and[1], { $lt: [{ $size: '$members' }, 4] });
  assert.deepEqual(filter.$expr.$and[0].$or[0], { $eq: [{ $ifNull: ['$seatLimits.agent', null] }, null] });
  assert.deepEqual(filter.$expr.$and[0].$or[1].$lt[0].$size.$filter.cond, { $eq: ['$$member.role', 'agent'] });
  assert.equal(filter.$expr.$and[0].$or[1].$lt[1], '$seatLimits.agent');
  assert.equal(membershipCapacityFilter('workspace', 'member', 'admin', { members: null }).$expr.$and.length, 1);
  assert.throws(() => membershipCapacityFilter('workspace', 'member', 'viewer', {members:null}, true), /Admin, Agent or Supervisor/);
  assert.deepEqual(membershipCapacityFilter('workspace', 'member', 'agent', { members: 0 }, true), { _id: 'workspace', deletedAt: null, 'members.user': { $ne: 'member' } });
});
