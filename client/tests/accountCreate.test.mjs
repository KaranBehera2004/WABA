import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/accountCreate.ts', import.meta.url), 'utf8');
const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
assert.equal(result.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
const module = { exports: {} };
vm.runInNewContext(result.outputText, { module, exports: module.exports, TextEncoder });
const { initialAccountCreateValues, readAccountPolicy, validateAccountCreate, createAccountPayload, newBusinessOwnerSeed, accountWorkspaceWarning } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const workspaceId = '6ac33ff090f7a65c9f5704c8';
const context = { workspaces: [{ _id: workspaceId, name: 'Registered Business', isActive: true }], policy: { passwordMinLength: 10, passwordRequireUppercase: false, passwordRequireNumber: false } };
const values = changes => ({ ...initialAccountCreateValues(), name: ' Test Account ', email: ' TEST@example.test ', password: 'TestingPassword9', confirmPassword: 'TestingPassword9', workspaceId, ...changes });
const payload = changes => plain(createAccountPayload(values(changes), context));

test('ordinary account creation defaults to a real existing-business selection and agent role', () => {
  const initial = initialAccountCreateValues();
  assert.equal(initial.mode, 'existing');
  assert.equal(initial.workspaceId, '');
  assert.equal(initial.workspaceRole, 'agent');
  assert.equal(initial.acknowledgePlatformAccess, false);
  assert.equal(validateAccountCreate(values(), context), null);
  assert.deepEqual(payload(), { name: 'Test Account', email: 'test@example.test', password: 'TestingPassword9', role: 'agent', workspaceId, workspaceRole: 'agent' });
});

test('business-role mapping is explicit and cannot inject owner or platform access', () => {
  assert.equal(payload({ workspaceRole: 'admin' }).role, 'admin');
  assert.equal(payload({ workspaceRole: 'supervisor' }).role, 'supervisor');
  assert.throws(() => payload({ workspaceRole: 'viewer' }), /Admin, Agent or Supervisor/);
  for (const workspaceRole of ['owner', 'superadmin', 'viewer', '']) assert.equal(validateAccountCreate(values({ workspaceRole }), context).field, 'workspaceRole');
  const input = values();
  Object.assign(input, { company: 'Typed fake business', role: 'superadmin', defaultWorkspace: 'other', members: ['attacker'], isActive: false });
  assert.deepEqual(plain(createAccountPayload(input, context)), payload());
  for (const workspaceId of ['', 'Typed company name', '507f1f77bcf86cd799439011']) assert.equal(validateAccountCreate(values({ workspaceId }), context).field, 'workspaceId');
});

test('name and email limits, matching passwords and administrator password floor are validated', () => {
  for (const name of ['', ' ', 'x'.repeat(81)]) assert.equal(validateAccountCreate(values({ name }), context).field, 'name');
  for (const email of ['', 'invalid', 'a@b', 'has spaces@example.test', 'x'.repeat(190) + '@example.test']) assert.equal(validateAccountCreate(values({ email }), context).field, 'email');
  assert.equal(validateAccountCreate(values({ name: 'x'.repeat(80) }), context), null);
  assert.equal(validateAccountCreate(values({ password: 'short', confirmPassword: 'short' }), context).field, 'password');
  assert.equal(validateAccountCreate(values({ confirmPassword: 'MismatchPassword9' }), context).field, 'confirmPassword');
  assert.equal(validateAccountCreate(values({ password: 'lowercasepassword', confirmPassword: 'lowercasepassword' }), context), null);
  for (const password of ['A9' + 'x'.repeat(71), 'A9' + 'é'.repeat(36)]) assert.equal(validateAccountCreate(values({ password, confirmPassword: password }), context).field, 'password');
  const password = 'A9' + 'x'.repeat(70);
  assert.equal(validateAccountCreate(values({ password, confirmPassword: password }), context), null);
});

test('loaded policy enforces stricter password minimum and requested complexity without stale fallback', () => {
  assert.deepEqual(plain(readAccountPolicy({ passwordMinLength: 8 })), { passwordMinLength: 10, passwordRequireUppercase: false, passwordRequireNumber: false });
  const policy = readAccountPolicy({ passwordMinLength: 20, passwordRequireUppercase: true, passwordRequireNumber: true });
  assert.equal(validateAccountCreate(values(), { ...context, policy }).field, 'password');
  assert.equal(validateAccountCreate(values({ password: 'lowercasepassword123456', confirmPassword: 'lowercasepassword123456' }), { ...context, policy }).field, 'password');
  assert.equal(validateAccountCreate(values({ password: 'UppercasePasswordLong', confirmPassword: 'UppercasePasswordLong' }), { ...context, policy }).field, 'password');
  for (const invalid of [null, [], 'invalid', {}, { passwordMinLength: 7 }, { passwordMinLength: 65 }, { passwordMinLength: 10.5 }, { passwordMinLength: 10, passwordRequireUppercase: 'true' }]) assert.throws(() => readAccountPolicy(invalid));
});

test('new business mode only creates an in-memory owner seed for the full setup wizard', () => {
  const input = values({ mode: 'new', workspaceId: '', workspaceRole: 'owner' });
  assert.equal(validateAccountCreate(input, context), null);
  assert.deepEqual(plain(newBusinessOwnerSeed(input, context)), { name: 'Test Account', email: 'test@example.test', password: 'TestingPassword9', confirmPassword: 'TestingPassword9' });
  assert.throws(() => createAccountPayload(input, context), /setup wizard/);
  assert.throws(() => newBusinessOwnerSeed(values(), context), /Choose New business/);
  for (const password of ['lowercasepassword9', 'UPPERCASEPASSWORD9', 'MixedCasePassword']) assert.equal(validateAccountCreate(values({ mode: 'new', password, confirmPassword: password }), context).field, 'password');
});

test('platform accounts require explicit acknowledgement and never inherit a business selection', () => {
  assert.equal(validateAccountCreate(values({ mode: 'platform' }), context).field, 'acknowledgePlatformAccess');
  const request = payload({ mode: 'platform', acknowledgePlatformAccess: true });
  assert.deepEqual(request, { name: 'Test Account', email: 'test@example.test', password: 'TestingPassword9', role: 'superadmin' });
  assert.equal(Object.hasOwn(request, 'workspaceId'), false);
  assert.equal(Object.hasOwn(request, 'workspaceRole'), false);
  assert.equal(Object.hasOwn(request, 'confirmPassword'), false);
  assert.equal(validateAccountCreate(values({ mode: 'unknown' }), context).field, 'mode');
});

test('suspended and expired businesses have explicit warnings without being silently activated', () => {
  const now = Date.UTC(2026, 9, 6);
  assert.equal(accountWorkspaceWarning(undefined, now), '');
  assert.equal(accountWorkspaceWarning(context.workspaces[0], now), '');
  assert.match(accountWorkspaceWarning({ ...context.workspaces[0], isActive: false }, now), /suspended/);
  assert.match(accountWorkspaceWarning({ ...context.workspaces[0], subscriptionEndsAt: '2026-10-05T00:00:00Z' }, now), /expired/);
  assert.equal(accountWorkspaceWarning({ ...context.workspaces[0], subscriptionEndsAt: '2026-10-07T00:00:00Z' }, now), '');
  assert.equal(validateAccountCreate(values(), { ...context, workspaces: [{ ...context.workspaces[0], isActive: false }] }), null);
});

test('account UI wires business setup, clears confirmed secrets, and cannot repeat a confirmed create', () => {
  const modal = readFileSync(new URL('../src/components/CreateAccountModal.tsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../src/pages/SuperAdmin.tsx', import.meta.url), 'utf8');
  const wizard = readFileSync(new URL('../src/components/CreateWorkspaceModal.tsx', import.meta.url), 'utf8');
  assert.match(modal, /values\.mode === 'new'[\s\S]*onNewBusiness\(newBusinessOwnerSeed\(values, context\)\); return;/);
  assert.match(modal, /if \(!confirmed\.current\) \{\s*await admin\.post\('\/users'/);
  assert.match(modal, /confirmed\.current = true;[\s\S]*password: '', confirmPassword: ''/);
  assert.doesNotMatch(modal, /localStorage|sessionStorage|URLSearchParams/);
  assert.match(admin, /initialOwner=\{workspaceOwnerSeed\}/);
  assert.match(admin, /setCreatingWorkspace\(false\); setWorkspaceOwnerSeed\(null\)/);
  assert.match(wizard, /newOwnerName: initialOwner\.name/);
  assert.match(wizard, /confirmOwnerPassword: initialOwner\.confirmPassword/);
});
