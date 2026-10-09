import test from 'node:test';
import assert from 'node:assert/strict';
import Workspace from '../models/Workspace.js';
import { FEATURES, PlatformPlan } from '../models/Platform.js';
import { effectiveWorkspacePlan, validateCustomPlan } from './workspacePlan.js';
import { workspaceFeatures } from './platform.js';
import { effectiveLimits } from './capacity.js';
import { newWorkspaceDefaults } from './platformConfig.js';
const input = { name: 'Negotiated Support', monthlyPrice: 1499.5, currency: 'INR', description: 'Agreed monthly subscription', features: ['contacts', 'conversations'], limits: { contacts: 100, members: 5 } };

test('negotiated plans validate money, modules and limits and reject privilege injection', () => {
  const result = validateCustomPlan({ ...input, updatedBy: 'forged', updatedAt: 'forged', plan: 'forged', isCustom: false });
  assert.equal(result.updatedBy, undefined); assert.equal(result.plan, undefined); assert.equal(result.monthlyPrice, 1499.5);
  assert.equal(result.limits.contacts, 100); assert.equal(result.limits.campaigns, null);
  for (const invalid of [null, [], { ...input, name: ' ' }, { ...input, name: 'x'.repeat(101) }, { ...input, monthlyPrice: -1 }, { ...input, monthlyPrice: '100' }, { ...input, monthlyPrice: 1.001 }, { ...input, monthlyPrice: Infinity }, { ...input, currency: 'invalid' }, { ...input, features: ['contacts', 'contacts'] }, { ...input, features: ['unknown'] }, { ...input, limits: { contacts: -1 } }, { ...input, limits: { contacts: 0.5 } }, { ...input, limits: { unknown: 1 } }, { ...input, description: {} }]) assert.throws(() => validateCustomPlan(invalid), error => error.status === 400);
  assert.equal(validateCustomPlan({ ...input, monthlyPrice: 0, features: [], limits: { contacts: 0 } }).limits.contacts, 0);
});

test('custom plans are business-specific; standard plan and new-business default stay unchanged', async () => {
  const id = '507f1f77bcf86cd799439011';
  const standard = { _id: id, name: 'Default', monthlyPrice: 1999, currency: 'INR', features: [...FEATURES], limits: { contacts: 1000, members: 10 } };
  const original = PlatformPlan.findById; let lookups = 0;
  PlatformPlan.findById = value => { assert.equal(String(value), id); lookups++; return { lean: async () => standard }; };
  try {
    const first = { plan: id, customPlan: validateCustomPlan(input), limits: {}, addonFeatures: [], disabledFeatures: [] };
    const second = { plan: id, limits: {}, disabledFeatures: [] };
    const negotiated = await effectiveWorkspacePlan(first); assert.equal(negotiated.monthlyPrice, input.monthlyPrice); assert.equal(negotiated.isCustom, true); assert.equal(lookups, 0);
    assert.deepEqual(await workspaceFeatures(first, { disabledFeatures: [] }), input.features);
    assert.equal((await effectiveLimits(first)).contacts, 100); assert.equal((await effectiveLimits(first)).members, 5);
    assert.equal((await effectiveWorkspacePlan(second)).monthlyPrice, 1999); assert.equal((await effectiveLimits(second)).contacts, 1000);
    assert.equal(standard.monthlyPrice, 1999); assert.equal(standard.features.length, FEATURES.length);
    const defaults = newWorkspaceDefaults({ defaultPlan: id, trialDays: 0, defaultTimezone: 'UTC' });
    assert.equal(String(defaults.plan), id); assert.equal(defaults.customPlan, undefined);
    assert.equal(new Workspace({ ...defaults }).customPlan, undefined);
    delete first.customPlan;
    assert.equal((await effectiveWorkspacePlan(first)).name, 'Default'); assert.equal((await effectiveLimits(first)).contacts, 1000);
  } finally { PlatformPlan.findById = original; }
});

test('workspace overrides and platform blocks still take precedence over negotiated terms', async () => {
  const workspace = { customPlan: validateCustomPlan(input), limits: { contacts: 0, members: null }, addonFeatures: ['templates'], disabledFeatures: ['conversations'] };
  assert.deepEqual(await workspaceFeatures(workspace, { disabledFeatures: ['templates'] }), ['contacts']);
  const limits = await effectiveLimits(workspace); assert.equal(limits.contacts, 0); assert.equal(limits.members, null);
});
