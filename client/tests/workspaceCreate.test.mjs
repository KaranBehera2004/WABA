import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the shipped form helpers without a browser, database or network.
const source = readFileSync(new URL('../src/lib/workspaceCreate.ts', import.meta.url), 'utf8');
const result = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const module = { exports: {} };
vm.runInNewContext(result.outputText, { module, exports: module.exports, TextEncoder });
const { initialWorkspaceCreateValues, readWorkspaceDefaults, validateWorkspaceCreate, createWorkspacePayload, selectedWorkspacePlan, isValidTimezone, workspaceSlug, effectiveWorkspaceFeatures } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const ownerId = '6ac33ff090f7a65c9f5704c8';
const planId = '6ac33ff090f7a65c9f5704c9';
const otherPlanId = '6ac33ff090f7a65c9f5704d0';
const features = ['contacts', 'conversations', 'calls', 'campaigns', 'templates', 'automations', 'analytics', 'dashboards', 'reports', 'segments', 'ads', 'team'];
const defaults = { defaultTimezone: 'Asia/Kolkata', defaultPlan: planId, trialDays: 14, disabledFeatures: ['ads'], sendingEnabled: true, passwordMinLength: 10 };
const context = {
  users: [{ _id: ownerId, name: 'Registered Owner', email: 'owner@example.test', isActive: true }, { _id: otherPlanId, name: 'Inactive Owner', isActive: false }],
  plans: [{ _id: planId, name: 'Starter', isActive: true, features: ['contacts', 'conversations', 'templates'], limits: { contacts: 50, campaigns: 0 } }, { _id: otherPlanId, name: 'Retired', isActive: false, features }],
  features, defaults,
};
const values = changes => ({ ...initialWorkspaceCreateValues(), name: ' New Business ', ownerMode: 'existing', owner: ownerId, timezone: 'Asia/Kolkata', ...changes });
const payload = changes => plain(createWorkspacePayload(values(changes), context));

test('initial form opts into inheritance without embedding a stale plan, expiry or capacity', () => {
  const initial = initialWorkspaceCreateValues();
  assert.equal(initial.ownerMode, 'new');
  assert.equal(initial.plan, 'inherit');
  assert.equal(initial.expiryMode, 'inherit');
  assert.equal(initial.trialDays, '');
  assert.deepEqual(plain(initial.limits), {});
  assert.deepEqual(plain(initial.unlimited), []);
  const request = payload();
  assert.equal(Object.hasOwn(request, 'plan'), false);
  assert.equal(Object.hasOwn(request, 'subscriptionEndsAt'), false);
  assert.equal(Object.hasOwn(request, 'trialDays'), false);
  assert.deepEqual(request.limits, {});
  assert.equal(request.name, 'New Business');
  assert.equal(request.settings.supportEmail, 'owner@example.test');
});

test('loaded defaults are validated and populated plan IDs are normalized', () => {
  assert.deepEqual(plain(readWorkspaceDefaults(defaults)), defaults);
  assert.deepEqual(plain(readWorkspaceDefaults({ ...defaults, defaultPlan: { _id: planId } })), defaults);
  assert.equal(readWorkspaceDefaults({ ...defaults, defaultPlan: null }).defaultPlan, null);
  for (const invalid of [null, [], 'invalid', {}, { ...defaults, defaultTimezone: '' }, { ...defaults, defaultTimezone: 'No/Such_Zone' }, { ...defaults, trialDays: -1 }, { ...defaults, trialDays: 366 }, { ...defaults, trialDays: 1.5 }, { ...defaults, defaultPlan: 'invalid' }]) assert.throws(() => readWorkspaceDefaults(invalid));
});

test('explicit no-plan choice overrides the default while active plan selection is retained', () => {
  assert.equal(payload({ plan: 'none' }).plan, null);
  assert.equal(selectedWorkspacePlan(values({ plan: 'none' }), context), undefined);
  assert.equal(payload({ plan: planId }).plan, planId);
  assert.equal(selectedWorkspacePlan(values(), context)._id, planId);
  assert.deepEqual(plain(selectedWorkspacePlan(values({ plan: planId }), context).features), ['contacts', 'conversations', 'templates']);
  for (const plan of ['invalid', otherPlanId]) assert.equal(validateWorkspaceCreate(values({ plan }), context).field, 'plan');
  const unavailableDefault = { ...context, defaults: { ...defaults, defaultPlan: otherPlanId } };
  assert.equal(validateWorkspaceCreate(values(), unavailableDefault).field, 'plan');
  assert.equal(validateWorkspaceCreate(values({ plan: 'none' }), unavailableDefault), null);
});

test('workspace feature disables remain explicit and cannot override platform or plan gates', () => {
  const request = payload({ disabledFeatures: ['calls', 'campaigns'] });
  assert.deepEqual(request.disabledFeatures, ['calls', 'campaigns']);
  // Global gates and plan catalogue stay in their own authority, not copied to the workspace.
  assert.equal(request.disabledFeatures.includes('ads'), false);
  assert.deepEqual(context.defaults.disabledFeatures, ['ads']);
  assert.throws(() => payload({ disabledFeatures: ['unknown'] }));
  assert.throws(() => payload({ disabledFeatures: ['calls', 'calls'] }));
});

test('no-expiry, zero-day trial and positive trial have distinct explicit payloads', () => {
  assert.equal(payload({ expiryMode: 'none' }).subscriptionEndsAt, null);
  const zero = payload({ expiryMode: 'trial', trialDays: '0' });
  assert.equal(zero.trialDays, 0);
  assert.equal(Object.hasOwn(zero, 'subscriptionEndsAt'), false);
  assert.equal(payload({ expiryMode: 'trial', trialDays: '365' }).trialDays, 365);
  for (const trialDays of ['', '-1', '366', '1.5', 'abc', 'Infinity']) assert.equal(validateWorkspaceCreate(values({ expiryMode: 'trial', trialDays }), context).field, 'trialDays');
});

test('custom expiry converts an exact browser-local date and time to ISO without date rollover', () => {
  const subscriptionEndsAt = '2026-10-20T23:59';
  const request = payload({ expiryMode: 'date', subscriptionEndsAt });
  assert.equal(request.subscriptionEndsAt, new Date(subscriptionEndsAt).toISOString());
  assert.equal(Object.hasOwn(request, 'trialDays'), false);
  assert.equal(payload({ expiryMode: 'date', subscriptionEndsAt: '2028-02-29T12:30:45' }).subscriptionEndsAt, new Date('2028-02-29T12:30:45').toISOString());
  for (const invalid of ['', '2026-02-29T12:30', '2026-04-31T12:30', '2026-10-20T24:00', '2026-10-20T12:60', '2026-10-20', 'bad-date']) assert.equal(validateWorkspaceCreate(values({ expiryMode: 'date', subscriptionEndsAt: invalid }), context).field, 'subscriptionEndsAt');
});

test('capacity blank inherits, unlimited is null, and zero blocks new activity', () => {
  const request = payload({ limits: { contacts: ' ', conversations: '0', calls: '12', members: '10' }, unlimited: ['campaigns', 'calls'] });
  assert.deepEqual(request.limits, { conversations: 0, calls: null, campaigns: null, members: 10 });
  assert.equal(Object.hasOwn(request.limits, 'contacts'), false);
  assert.equal(Object.hasOwn(request.limits, 'ads'), false);
  assert.deepEqual(context.plans[0].limits, { contacts: 50, campaigns: 0 });
});

test('capacity rejects negatives, fractions, unsafe values, unknown keys and pasted JSON', () => {
  for (const value of ['-1', '1.5', 'Infinity', '9007199254740992', '{"contacts":100}', '1e3']) {
    const error = validateWorkspaceCreate(values({ limits: { contacts: value } }), context);
    assert.equal(error.step, 'Capacity');
    assert.equal(error.field, 'limit-contacts');
  }
  assert.equal(validateWorkspaceCreate(values({ limits: { token: '10' } }), context).step, 'Capacity');
  assert.equal(validateWorkspaceCreate(values({ unlimited: ['unknown'] }), context).step, 'Capacity');
  assert.equal(payload({ limits: { contacts: '9007199254740991' } }).limits.contacts, Number.MAX_SAFE_INTEGER);
});

test('required business fields and active owner are checked before submission', () => {
  for (const name of ['', ' ', 'n'.repeat(121)]) assert.equal(validateWorkspaceCreate(values({ name }), context).field, 'name');
  assert.equal(validateWorkspaceCreate(values({ name: 'n'.repeat(120) }), context), null);
  for (const owner of ['', 'unregistered', otherPlanId]) assert.equal(validateWorkspaceCreate(values({ owner }), context).field, 'owner');
  for (const timezone of ['', 'No/Such_Zone', 'x'.repeat(101)]) assert.equal(validateWorkspaceCreate(values({ timezone }), context).field, 'timezone');
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('No/Such_Zone'), false);
});

test('contact fields and private notes trim values and enforce their maximum lengths', () => {
  assert.equal(payload({ supportEmail: ' help@example.test ', businessDescription: ' A business ', adminNotes: ' Internal note ' }).settings.supportEmail, 'help@example.test');
  assert.equal(payload({ businessDescription: ' A business ', adminNotes: ' Internal note ' }).settings.businessDescription, 'A business');
  assert.equal(payload({ adminNotes: ' Internal note ' }).adminNotes, 'Internal note');
  for (const supportEmail of ['invalid', 'a@b', 'hello there@example.test', 'x'.repeat(190) + '@example.test']) assert.equal(validateWorkspaceCreate(values({ supportEmail }), context).field, 'supportEmail');
  assert.equal(validateWorkspaceCreate(values({ businessDescription: 'x'.repeat(3001) }), context).field, 'businessDescription');
  assert.equal(validateWorkspaceCreate(values({ adminNotes: 'x'.repeat(3001) }), context).field, 'adminNotes');
  assert.equal(validateWorkspaceCreate(values({ businessDescription: 'x'.repeat(3000), adminNotes: 'x'.repeat(3000) }), context), null);
});

test('final submission validates hidden steps and only emits allowlisted configuration', () => {
  assert.equal(validateWorkspaceCreate(values({ adminNotes: 'x'.repeat(3001) }), context, 'Business'), null);
  assert.equal(validateWorkspaceCreate(values({ adminNotes: 'x'.repeat(3001) }), context, 'Review').step, 'Capacity');
  const input = values({ isActive: false, sendingEnabled: false });
  Object.assign(input, { members: [{ user: 'unregistered', role: 'superadmin' }], wallet: { balancePaise: 99999999 }, whatsapp: { connected: true }, password: 'never-submit', permissionRules: [], dangerous: true });
  const request = plain(createWorkspacePayload(input, context));
  assert.equal(request.isActive, false);
  assert.equal(request.sendingEnabled, false);
  assert.deepEqual(Object.keys(request).sort(), ['name', 'owner', 'email', 'phone', 'isActive', 'sendingEnabled', 'settings', 'disabledFeatures', 'addonFeatures', 'limits', 'seatLimits', 'adminNotes'].sort());
  for (const key of ['slug', 'members', 'wallet', 'whatsapp', 'password', 'permissionRules', 'dangerous']) assert.equal(Object.hasOwn(request, key), false);
  assert.throws(() => createWorkspacePayload(values({ limits: { contacts: '-1' } }), context));
});

const newOwnerValues = changes => values({ ownerMode: 'new', newOwnerName: ' New Owner ', newOwnerEmail: ' NEW@example.test ', newOwnerPassword: 'TestingPassword9', confirmOwnerPassword: 'TestingPassword9', ...changes });

test('create owner login sends one allowlisted account, not an existing-owner ID or confirmation', () => {
  const input = newOwnerValues();
  Object.assign(input, { newOwnerRole: 'superadmin', passwordHash: 'injected' });
  const request = plain(createWorkspacePayload(input, context));
  assert.deepEqual(request.newOwner, { name: 'New Owner', email: 'new@example.test', password: 'TestingPassword9' });
  assert.equal(Object.hasOwn(request, 'owner'), false);
  assert.equal(Object.hasOwn(request, 'confirmOwnerPassword'), false);
  assert.equal(Object.hasOwn(request, 'passwordHash'), false);
  assert.equal(request.settings.supportEmail, 'new@example.test');
  assert.equal(Object.hasOwn(payload(), 'newOwner'), false);
});

test('new owner fields, password strength, confirmation, policy length and UTF-8 byte cap are validated', () => {
  assert.equal(validateWorkspaceCreate(newOwnerValues(), context), null);
  for (const newOwnerName of ['', ' ', 'x'.repeat(81)]) assert.equal(validateWorkspaceCreate(newOwnerValues({ newOwnerName }), context).field, 'newOwnerName');
  for (const newOwnerEmail of ['', 'invalid', 'a@b', 'hello there@example.test', 'x'.repeat(190) + '@example.test']) assert.equal(validateWorkspaceCreate(newOwnerValues({ newOwnerEmail }), context).field, 'newOwnerEmail');
  for (const newOwnerPassword of ['Short9A', 'alllowercase9', 'ALLUPPERCASE9', 'NoNumbersHere', 'Ab9' + 'x'.repeat(70), 'Ab9' + 'é'.repeat(35)]) assert.equal(validateWorkspaceCreate(newOwnerValues({ newOwnerPassword, confirmOwnerPassword: newOwnerPassword }), context).field, 'newOwnerPassword');
  assert.equal(validateWorkspaceCreate(newOwnerValues({ newOwnerPassword: 'Ab9' + 'x'.repeat(69), confirmOwnerPassword: 'Ab9' + 'x'.repeat(69) }), context), null);
  assert.equal(validateWorkspaceCreate(newOwnerValues({ confirmOwnerPassword: 'DifferentPassword9' }), context).field, 'confirmOwnerPassword');
  assert.equal(validateWorkspaceCreate(newOwnerValues(), { ...context, defaults: { ...defaults, passwordMinLength: 20 } }).field, 'newOwnerPassword');
  assert.equal(validateWorkspaceCreate(newOwnerValues({ ownerMode: 'unknown' }), context).field, 'ownerMode');
  assert.equal(readWorkspaceDefaults({ ...defaults, passwordMinLength: 8 }).passwordMinLength, 10);
  assert.equal(readWorkspaceDefaults({ ...defaults, passwordMinLength: 20 }).passwordMinLength, 20);
});

test('business identifier suggestions and optional business contacts are normalized and validated', () => {
  assert.equal(workspaceSlug('  Example Business!  '), 'example-business');
  assert.equal(workspaceSlug('a'.repeat(59) + ' b'), 'a'.repeat(59));
  assert.equal(workspaceSlug('你好'), '');
  const request = payload({ slug: ' my-business ', businessEmail: ' BUSINESS@example.test ', businessPhone: ' +91 12345 67890 ' });
  assert.equal(request.slug, 'my-business');
  assert.equal(request.email, 'business@example.test');
  assert.equal(request.phone, '+91 12345 67890');
  assert.equal(request.settings.supportEmail, 'owner@example.test');
  assert.equal(Object.hasOwn(payload({ slug: '' }), 'slug'), false);
  for (const slug of ['ab', '-invalid', 'invalid-', 'Uppercase', 'spaces here', 'x'.repeat(61)]) assert.equal(validateWorkspaceCreate(values({ slug }), context).field, 'slug');
  assert.equal(validateWorkspaceCreate(values({ slug: 'x'.repeat(60), businessPhone: 'x'.repeat(32) }), context), null);
  assert.equal(validateWorkspaceCreate(values({ businessPhone: 'x'.repeat(33) }), context).field, 'businessPhone');
  for (const businessEmail of ['invalid', 'a@b', 'hello there@example.test', 'x'.repeat(190) + '@example.test']) assert.equal(validateWorkspaceCreate(values({ businessEmail }), context).field, 'businessEmail');
});

test('add-ons expand plan entitlements, never workspace or platform restrictions', () => {
  assert.deepEqual(plain(effectiveWorkspaceFeatures(values(), context)), ['contacts', 'conversations', 'templates']);
  const input = values({ addonFeatures: ['campaigns', 'calls', 'ads'], disabledFeatures: ['calls'] });
  assert.deepEqual(plain(effectiveWorkspaceFeatures(input, context)), ['contacts', 'conversations', 'campaigns', 'templates']);
  assert.deepEqual(payload({ addonFeatures: ['campaigns'] }).addonFeatures, ['campaigns']);
  for (const addonFeatures of [['unknown'], ['calls', 'calls']]) assert.equal(validateWorkspaceCreate(values({ addonFeatures }), context).step, 'Access & plan');
  assert.equal(effectiveWorkspaceFeatures(values({ plan: 'none' }), context).includes('calls'), true);
  assert.equal(effectiveWorkspaceFeatures(values({ plan: 'none' }), context).includes('ads'), false);
});

test('role seats preserve zero and explicit unlimited, exclude unsupported roles and cap each role', () => {
  assert.deepEqual(payload().seatLimits, { admin: null, agent: null, supervisor: null });
  assert.deepEqual(payload({ seatLimits: { admin: ' 0 ', agent: '100000' } }).seatLimits, { admin: 0, agent: 100000, supervisor: null });
  for (const admin of ['-1', '1.5', '1e3', '100001', 'Infinity']) assert.equal(validateWorkspaceCreate(values({ seatLimits: { admin } }), context).field, 'seat-admin');
  for (const role of ['owner', 'superadmin', 'token']) assert.equal(validateWorkspaceCreate(values({ seatLimits: { [role]: '1' } }), context).step, 'Capacity');
});

test('review never renders owner passwords and a confirmed creation clears form secrets', () => {
  const modal = readFileSync(new URL('../src/components/CreateWorkspaceModal.tsx', import.meta.url), 'utf8');
  const review = modal.slice(modal.indexOf("{step === 'Review' &&"), modal.indexOf('{created &&'));
  assert.ok(review.length > 100);
  assert.doesNotMatch(review, /newOwnerPassword|confirmOwnerPassword/);
  assert.match(modal, /confirmed\.current = true;[\s\S]*newOwnerPassword: '', confirmOwnerPassword: ''/);
});
