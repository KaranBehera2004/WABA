import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, DEFAULT_PERMISSIONS, ROLE_PERMISSION_LIMITS, permissionsFor, requestCapability, validateCapacities, validatePermissionRules } from './accessControl.js';

test('active business roles have bounded default permissions; owners retain Admin management', () => {
  assert.equal(DEFAULT_PERMISSIONS.viewer, undefined);
  assert.deepEqual(permissionsFor({}, {role:'viewer'}, 'agent'), []);
  assert.ok(!DEFAULT_PERMISSIONS.agent.includes('contacts.create'));
  assert.ok(!DEFAULT_PERMISSIONS.agent.includes('contacts.delete'));
  assert.ok(!DEFAULT_PERMISSIONS.agent.includes('campaigns.send'));
  for (const permission of ['campaigns.create', 'campaigns.read', 'automations.update', 'dashboards.create', 'reports.create', 'team.manage', 'workspace.manage', 'integrations.manage']) assert.ok(!DEFAULT_PERMISSIONS.agent.includes(permission), permission);
  assert.ok(DEFAULT_PERMISSIONS.agent.includes('conversations.send'));
  assert.ok(DEFAULT_PERMISSIONS.agent.includes('templates.read'));
  assert.ok(!DEFAULT_PERMISSIONS.agent.includes('segments.update'));
  assert.ok(!DEFAULT_PERMISSIONS.agent.includes('wallet.read'));
  assert.deepEqual(permissionsFor({}, { role: 'admin' }, 'agent'), CAPABILITIES);
  const restricted = { permissionRules: [{ role: 'admin', permissions: [] }] };
  assert.deepEqual(permissionsFor(restricted, { role: 'admin' }, 'owner'), []);
  assert.deepEqual(permissionsFor(restricted, { role: 'owner' }, 'owner'), CAPABILITIES);
  assert.deepEqual(permissionsFor(restricted, { role: 'viewer' }, 'superadmin'), CAPABILITIES);
});
test('retired roles cannot regain access through stored grants; active overrides still apply', () => {
  assert.deepEqual(permissionsFor({ permissionRules: [{ role: 'viewer', permissions: ['contacts.read', 'contacts.create'] }] }, { role: 'viewer' }, 'agent'), []);
  assert.deepEqual(permissionsFor({ permissionRules: [{ role: 'agent', permissions: ['contacts.read', 'contacts.create', 'wallet.read', 'integrations.manage'] }] }, { role: 'agent' }, 'agent'), ['contacts.read']);
  assert.deepEqual(permissionsFor({ permissionRules: [{ role: 'agent', permissions: [] }] }, { role: 'agent' }, 'agent'), []);
  assert.ok(!validatePermissionRules([{ role: 'viewer', permissions: ['contacts.create'] }]));
  assert.ok(!validatePermissionRules([{ role: 'owner', permissions: [] }]));
  assert.ok(!validatePermissionRules([{ role: 'agent', permissions: ['root'] }]));
  assert.ok(!validatePermissionRules([{ role: 'admin', permissions: [] }, { role: 'admin', permissions: [] }]));
});
test('API paths map to sending, exporting, membership and CRUD capabilities', () => {
  assert.equal(requestCapability('POST', '/api/integrations/smartping/campaigns/123/send'), 'campaigns.send');
  assert.equal(requestCapability('POST', '/api/conversations/123/messages'), 'conversations.send');
  assert.equal(requestCapability('GET', '/api/conversations/123/messages'), 'conversations.read');
  assert.equal(requestCapability('POST', '/api/workspaces/current/invite'), 'team.manage');
  assert.equal(requestCapability('PATCH', '/api/workspaces/current'), 'workspace.manage');
  assert.equal(requestCapability('GET', '/api/workspaces/current'), null);
  assert.equal(requestCapability('POST', '/api/integrations/smartping/templates/123/configure'), 'integrations.manage');
  assert.equal(requestCapability('DELETE', '/api/contacts/123'), 'contacts.delete');
  assert.equal(requestCapability('GET', '/api/reports/123/download'), 'reports.read');
  assert.equal(requestCapability('POST', '/API/INTEGRATIONS/SMARTPING/CAMPAIGNS/123/SEND/'), 'campaigns.send');
  assert.equal(requestCapability('POST', '/api/conversations/123/messages/'), 'conversations.send');
  assert.equal(requestCapability('PATCH', '/api/workspaces/current/'), 'workspace.manage');
  assert.equal(requestCapability('POST', '/api/workspaces/current/invite/'), 'team.manage');
});
test('root permission configuration accepts business grants while defaults remain restricted and honors explicit claim removal', () => {
  for (const capability of ['wallet.read', 'integrations.manage', 'campaigns.send', 'team.manage', 'contacts.delete', 'contacts.create']) {
    assert.ok(!ROLE_PERMISSION_LIMITS.agent.includes(capability));
    assert.equal(validatePermissionRules([{ role: 'agent', permissions: [capability] }]), true);
  }
  assert.equal(validatePermissionRules([{ role: 'agent', permissions: ['conversations.read', 'conversations.send', 'conversations.claim'] }]), true);
  assert.equal(validatePermissionRules([{ role: 'admin', permissions: CAPABILITIES }]), true);
  const membership = { role: 'agent', canClaim: true };
  const workspace = { settings: { routing: { allowClaim: true } } };
  assert.ok(permissionsFor(workspace, membership, 'agent').includes('conversations.claim'));
  workspace.permissionRules = [{ role: 'agent', permissions: ['conversations.read'] }];
  assert.deepEqual(permissionsFor(workspace, membership, 'agent'), ['conversations.read']);
  workspace.permissionRules[0].permissions.push('conversations.claim');
  assert.ok(permissionsFor(workspace, membership, 'agent').includes('conversations.claim'));
});
test('capacity input rejects unknown resources, fractions, strings and negative numbers', () => {
  assert.ok(validateCapacities({ contacts: 0, members: 20, templates: null }));
  for (const input of [{ contacts: -1 }, { contacts: 1.2 }, { contacts: '100' }, { password: 1 }, [], null]) assert.ok(!validateCapacities(input));
});
