import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES } from '../models/Platform.js';
import { validateWorkspaceBusinessFields, validateWorkspaceConfiguration, validateWorkspaceOwner } from './workspaceConfig.js';

test('workspace creation validates and copies only supported configuration', () => {
  const input = { name: ' Test business ', owner: 'not forwarded', plan: '507f1f77bcf86cd799439011', isActive: false, sendingEnabled: false, subscriptionEndsAt: '2030-04-05T15:30:00+05:30', disabledFeatures: [FEATURES[0]], settings: { timezone: 'Asia/Kolkata', supportEmail: ' support@example.com ', businessDescription: ' Description ', token: 'secret' }, limits: { contacts: 0, members: null }, adminNotes: ' Notes ', permissionRules: [], whatsapp: { connected: true } };
  const result = validateWorkspaceConfiguration(input);
  assert.equal(result.name, 'Test business');
  assert.equal(result.plan, input.plan);
  assert.equal(result.isActive, false); assert.equal(result.sendingEnabled, false);
  assert.equal(result.subscriptionEndsAt.toISOString(), '2030-04-05T10:00:00.000Z');
  assert.deepEqual(result.settings, { timezone: 'Asia/Kolkata', supportEmail: 'support@example.com', businessDescription: 'Description' });
  assert.deepEqual(result.limits, { contacts: 0, members: null });
  assert.equal(result.adminNotes, 'Notes');
  for (const key of ['owner', 'permissionRules', 'whatsapp']) assert.equal(result[key], undefined);
  assert.notEqual(result.limits, input.limits); assert.notEqual(result.disabledFeatures, input.disabledFeatures);
});

test('business identifiers, contact details, add-ons and role seats are normalized and copied', () => {
  const input = { name: 'Business', slug: ' My-Business ', email: ' CONTACT@EXAMPLE.COM ', phone: ' +919876543210 ', addonFeatures: ['campaigns', 'automations'], seatLimits: { admin: 0, agent: 100000 } };
  const result = validateWorkspaceConfiguration(input);
  assert.equal(result.slug, 'my-business'); assert.equal(result.email, 'contact@example.com'); assert.equal(result.phone, '+919876543210');
  assert.deepEqual(result.addonFeatures, input.addonFeatures); assert.notEqual(result.addonFeatures, input.addonFeatures);
  assert.deepEqual(result.seatLimits, input.seatLimits); assert.notEqual(result.seatLimits, input.seatLimits);
  assert.deepEqual(validateWorkspaceBusinessFields({ phone: '', email: '' }), { phone: '', email: '' });
  for (const body of [{ slug: 'ab' }, { slug: '-business' }, { slug: 'bad_slug' }, { slug: 'a'.repeat(61) }, { email: 'bad' }, { phone: 'x'.repeat(33) }, { addonFeatures: ['ivr'] }, { addonFeatures: ['contacts', 'contacts'] }, { seatLimits: null }, { seatLimits: { owner: 1 } }, { seatLimits: { agent: '2' } }, { seatLimits: { viewer: 0 } }, { seatLimits: { viewer: null } }, { seatLimits: { admin: 1.5 } }, { seatLimits: { admin: 100001 } }]) assert.throws(() => validateWorkspaceBusinessFields(body), error => error.status === 400, JSON.stringify(body));
});

test('business owner mode is exclusive and new owners use baseline and platform password policies', () => {
  const owner = { name: ' Owner ', email: ' OWNER@EXAMPLE.COM ', password: 'LongPassword123', role: 'superadmin', isActive: false };
  assert.deepEqual(validateWorkspaceOwner({ newOwner: owner }, {}), { newOwner: { name: 'Owner', email: 'owner@example.com', password: owner.password } });
  assert.deepEqual(validateWorkspaceOwner({ owner: '507f1f77bcf86cd799439011' }, {}), { owner: '507f1f77bcf86cd799439011' });
  for (const body of [{}, { owner: 'bad' }, { owner: null }, { owner: '507f1f77bcf86cd799439011', newOwner: owner }, { newOwner: null }, { newOwner: { ...owner, name: '' } }, { newOwner: { ...owner, name: 'x'.repeat(81) } }, { newOwner: { ...owner, email: 'bad' } }, ...['shortA1', 'alllowercase1', 'ALLUPPERCASE1', 'WithoutNumber', 'LongPassword1' + '😀'.repeat(20)].map(password => ({ newOwner: { ...owner, password } }))]) assert.throws(() => validateWorkspaceOwner(body, {}), error => error.status === 400);
  assert.throws(() => validateWorkspaceOwner({ newOwner: owner }, { passwordMinLength: 20 }), /at least 20/);
});

test('workspace creation supports omitted defaults, partial settings and explicit no-plan/no-expiry', () => {
  assert.deepEqual(validateWorkspaceConfiguration({ name: 'Workspace' }), { name: 'Workspace' });
  assert.deepEqual(validateWorkspaceConfiguration({ name: 'Workspace', plan: null, subscriptionEndsAt: null, settings: { supportEmail: '' }, limits: {} }), { name: 'Workspace', plan: null, subscriptionEndsAt: null, settings: { supportEmail: '' }, limits: {} });
  assert.deepEqual(validateWorkspaceConfiguration({ name: 'Workspace', trialDays: 0 }), { name: 'Workspace', trialDays: 0 });
  assert.equal(validateWorkspaceConfiguration({ name: 'Workspace', subscriptionEndsAt: '2032-02-29' }).subscriptionEndsAt.toISOString(), '2032-02-29T00:00:00.000Z');
});

test('workspace creation rejects malformed fields before any database work', () => {
  const invalid = [
    null, [], { name: '' }, { name: 42 }, { name: 'a'.repeat(121) },
    { isActive: 'false' }, { sendingEnabled: 0 }, { plan: '' }, { plan: {} }, { plan: 'bad-id' },
    { subscriptionEndsAt: '' }, { subscriptionEndsAt: 1234 }, { subscriptionEndsAt: '2030-02-30' }, { subscriptionEndsAt: '2031-02-29' }, { subscriptionEndsAt: '2030-01-01T24:00:00Z' }, { subscriptionEndsAt: 'not-a-date' },
    { trialDays: -1 }, { trialDays: 366 }, { trialDays: '7' }, { trialDays: 1.5 }, { trialDays: null }, { trialDays: 7, subscriptionEndsAt: null },
    { disabledFeatures: 'contacts' }, { disabledFeatures: ['unknown'] }, { disabledFeatures: [FEATURES[0], FEATURES[0]] },
    { settings: null }, { settings: [] }, { settings: { timezone: 'Bad/Timezone' } }, { settings: { timezone: '' } }, { settings: { supportEmail: 'bad' } }, { settings: { supportEmail: null } }, { settings: { businessDescription: 'a'.repeat(3001) } },
    { limits: null }, { limits: [] }, { limits: { unknown: 1 } }, { limits: { contacts: -1 } }, { limits: { contacts: 1.5 } }, { limits: { members: '3' } }, { limits: { members: Number.MAX_SAFE_INTEGER + 1 } },
    { adminNotes: null }, { adminNotes: 'a'.repeat(3001) },
  ];
  for (const input of invalid) assert.throws(() => validateWorkspaceConfiguration(input && !Array.isArray(input) ? { name: 'Workspace', ...input } : input), error => error.status === 400, JSON.stringify(input));
});
