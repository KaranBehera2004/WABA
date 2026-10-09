import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSuperadminAccount } from './superadminUser.js';

const details = { name: ' New account ', email: ' USER@EXAMPLE.COM ', password: 'LongPassword123', role: 'agent' };
const workspaceId = '507f1f77bcf86cd799439011';

test('linked account validation maps safe business roles and never trusts company or access injections', () => {
  for (const workspaceRole of ['admin', 'agent']) {
    const role = workspaceRole === 'admin' ? 'admin' : 'agent';
    const result = validateSuperadminAccount({ ...details, role, workspaceId, workspaceRole, company: 'Unrelated company', isActive: false, defaultWorkspace: 'different-business', membership: 'owner', sessionVersion: 999 }, {});
    assert.deepEqual(result, { payload: { name: 'New account', email: 'user@example.com', password: details.password, role }, workspaceId, workspaceRole });
  }
});

test('legacy unlinked accounts and platform superadmins keep their existing creation contract', () => {
  for (const role of ['owner', 'admin', 'agent', 'superadmin']) {
    assert.deepEqual(validateSuperadminAccount({ ...details, role, company: ' Legacy company ' }, {}), { payload: { name: 'New account', email: 'user@example.com', password: details.password, role, company: 'Legacy company' } });
  }
  assert.equal(validateSuperadminAccount({ ...details, role: 'superadmin' }, {}).workspaceId, undefined);
});

test('linked accounts reject owner/superadmin escalation and incomplete or inconsistent business roles', () => {
  const linked = { ...details, workspaceId, workspaceRole: 'agent' };
  const invalid = [
    { ...linked, role: 'owner' }, { ...linked, role: 'superadmin' }, { ...linked, role: 'admin' },
    { ...linked, workspaceRole: 'viewer' }, { ...linked, workspaceRole: 'owner' }, { ...linked, workspaceRole: 'superadmin' }, { ...linked, workspaceRole: 'admin' },
    { ...linked, workspaceRole: undefined }, { ...linked, workspaceId: undefined }, { ...linked, workspaceId: null }, { ...linked, workspaceId: '' }, { ...linked, workspaceId: 'bad' },
  ];
  for (const input of invalid) assert.throws(() => validateSuperadminAccount(input, {}), error => error.status === 400);
});

test('new account field and password validation reject malformed values before any DB work', () => {
  const invalid = [null, [], { ...details, name: '' }, { ...details, name: 2 }, { ...details, name: 'x'.repeat(81) }, { ...details, email: 'bad' }, { ...details, email: 'x'.repeat(201) }, { ...details, role: 'root' }, { ...details, password: 'short' }, { ...details, password: 'LongPassword1' + '😀'.repeat(20) }, { ...details, company: 42 }];
  for (const input of invalid) assert.throws(() => validateSuperadminAccount(input, {}), error => error.status === 400);
  assert.throws(() => validateSuperadminAccount(details, { passwordMinLength: 20 }), /at least 20/);
  assert.throws(() => validateSuperadminAccount({ ...details, password: 'longpassword123' }, { passwordRequireUppercase: true }), /uppercase/);
});
