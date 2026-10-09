import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, PlatformSettings } from '../models/Platform.js';
import { PLATFORM_DEFAULTS, validatePlatformConfig, passwordPolicyError, signupAllowed, sessionExpiry, newWorkspaceDefaults } from './platformConfig.js';
import { platformSettings } from './platform.js';

const validate = body => validatePlatformConfig(body, FEATURES);

test('platform config accepts only editable keys and normalizes branding and domains', () => {
  assert.deepEqual(validate({ platformName: ' My WABA ', supportEmail: ' help@example.com ', allowedSignupDomains: [' Example.com ', 'example.com', 'team.company.org'], controlVersion: 900, key: 'other', token: 'never-store' }), {
    platformName: 'My WABA', supportEmail: 'help@example.com', allowedSignupDomains: ['example.com', 'team.company.org'],
  });
});

test('platform switches require booleans, not truthy strings or numbers', () => {
  for (const field of ['registrationEnabled', 'memberAccessEnabled', 'workspaceCreationEnabled', 'maintenanceEnabled', 'sendingEnabled', 'broadcastsEnabled', 'passwordRequireNumber', 'passwordRequireUppercase']) {
    assert.throws(() => validate({ [field]: 'false' }), /true or false/);
    assert.throws(() => validate({ [field]: 0 }), /true or false/);
    assert.deepEqual(validate({ [field]: false }), { [field]: false });
  }
});

test('platform numeric controls reject fractions, out-of-range values and invalid nulls', () => {
  const ranges = { maxBroadcastRecipients: [1, 100], trialDays: [0, 365], workspaceLimitPerOwner: [0, 1000], passwordMinLength: [8, 64], sessionLifetimeHours: [1, 720] };
  for (const [field, [min, max]] of Object.entries(ranges)) {
    for (const invalid of [min - 1, max + 1, 8.5, '10', NaN, Infinity]) assert.throws(() => validate({ [field]: invalid }), /whole number/);
    assert.deepEqual(validate({ [field]: min }), { [field]: min });
    assert.deepEqual(validate({ [field]: max }), { [field]: max });
  }
  assert.deepEqual(validate({ workspaceLimitPerOwner: null, sessionLifetimeHours: null }), { workspaceLimitPerOwner: null, sessionLifetimeHours: null });
  assert.throws(() => validate({ passwordMinLength: null }), /whole number/);
});

test('platform branding validates types, lengths, required text and public links', () => {
  assert.throws(() => validate({ platformName: {} }), /platformName/);
  assert.throws(() => validate({ platformName: ' ' }), /cannot be empty/);
  assert.throws(() => validate({ loginDescription: 'x'.repeat(501) }), /loginDescription/);
  assert.throws(() => validate({ supportEmail: 'not-an-email' }), /email/);
  for (const field of ['supportUrl', 'termsUrl', 'privacyUrl']) {
    for (const invalid of ['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com', 'not-a-url']) assert.throws(() => validate({ [field]: invalid }), /HTTPS/);
    assert.equal(validate({ [field]: 'https://example.com/help?q=1' })[field], 'https://example.com/help?q=1');
    assert.equal(validate({ [field]: '' })[field], '');
  }
});

test('platform defaults accept only valid timezones, plans, domains and module names', () => {
  assert.equal(validate({ defaultTimezone: 'Asia/Kolkata' }).defaultTimezone, 'Asia/Kolkata');
  assert.throws(() => validate({ defaultTimezone: 'Not/A_Timezone' }), /timezone/);
  assert.throws(() => validate({ defaultPlan: 'wrong-id' }), /default plan/);
  assert.equal(validate({ defaultPlan: null }).defaultPlan, null);
  assert.deepEqual(validate({ disabledFeatures: ['templates', 'team'] }).disabledFeatures, ['templates', 'team']);
  for (const invalid of [['templates', 'templates'], ['unknown'], 'team']) assert.throws(() => validate({ disabledFeatures: invalid }), /distinct/);
  for (const invalid of [['@example.com'], ['*.example.com'], ['https://example.com'], ['localhost'], [12], Array(101).fill('example.com')]) assert.throws(() => validate({ allowedSignupDomains: invalid }), /domains/);
});

test('password policy preserves defaults and enforces new password complexity and admin floor', () => {
  assert.equal(passwordPolicyError('password', PLATFORM_DEFAULTS), '');
  assert.match(passwordPolicyError('short', PLATFORM_DEFAULTS), /8 characters/);
  assert.match(passwordPolicyError('password', PLATFORM_DEFAULTS, 10), /10 characters/);
  const policy = { ...PLATFORM_DEFAULTS, passwordMinLength: 12, passwordRequireUppercase: true, passwordRequireNumber: true };
  assert.match(passwordPolicyError('longpassword1', policy), /uppercase/);
  assert.match(passwordPolicyError('Longpassword', policy), /number/);
  assert.equal(passwordPolicyError('Longpassword1', policy), '');
  assert.match(passwordPolicyError('x'.repeat(73), PLATFORM_DEFAULTS), /72 UTF-8 bytes/);
  assert.match(passwordPolicyError('é'.repeat(37), PLATFORM_DEFAULTS), /72 UTF-8 bytes/);
});

test('signup restrictions are exact domains and sessions inherit environment until overridden', () => {
  const settings = { ...PLATFORM_DEFAULTS, ...validate({ allowedSignupDomains: ['EXAMPLE.COM'] }) };
  assert.equal(signupAllowed('user@example.com', settings), true);
  assert.equal(signupAllowed('user@sub.example.com', settings), false);
  assert.equal(signupAllowed('user@other.com', settings), false);
  assert.equal(signupAllowed('user@other.com', PLATFORM_DEFAULTS), true);
  assert.equal(sessionExpiry(PLATFORM_DEFAULTS, {}), '7d');
  assert.equal(sessionExpiry(PLATFORM_DEFAULTS, { JWT_EXPIRES_IN: '2d' }), '2d');
  assert.equal(sessionExpiry({ sessionLifetimeHours: 2 }, { JWT_EXPIRES_IN: '2d' }), 7200);
});

test('new workspace defaults are opt-in and calculate exact trial expiry without mutation', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const settings = { ...PLATFORM_DEFAULTS, trialDays: 14, defaultPlan: '507f1f77bcf86cd799439013', defaultTimezone: 'UTC' };
  assert.deepEqual(newWorkspaceDefaults(PLATFORM_DEFAULTS), { timezone: 'Asia/Kolkata' });
  const result = newWorkspaceDefaults(settings, true, now);
  assert.equal(result.plan, settings.defaultPlan);
  assert.equal(result.subscriptionEndsAt.toISOString(), '2026-10-19T12:00:00.000Z');
  assert.equal(result.timezone, 'UTC');
  assert.equal(now.toISOString(), '2026-10-05T12:00:00.000Z');
  assert.equal(newWorkspaceDefaults(settings, false, now).plan, undefined);
});

test('legacy settings documents receive new safe defaults without a database write', async () => {
  const original = PlatformSettings.findOne;
  let document = { platformName: 'Existing brand', sendingEnabled: false };
  PlatformSettings.findOne = filter => { assert.deepEqual(filter, { key: 'platform' }); return { lean: async () => document }; };
  try {
    const settings = await platformSettings();
    assert.equal(settings.platformName, 'Existing brand');
    assert.equal(settings.sendingEnabled, false);
    assert.equal(settings.memberAccessEnabled, true);
    assert.equal(settings.maxBroadcastRecipients, 100);
    assert.equal(settings.defaultPlan, null);
    document = null;
    assert.deepEqual(await platformSettings(), PLATFORM_DEFAULTS);
  } finally { PlatformSettings.findOne = original; }
});
