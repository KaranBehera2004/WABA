import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/workspaceAccess.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const module = { exports: {} };
vm.runInNewContext(output.outputText, { module, exports: module.exports });
const { can, canOpenPage, resolveWorkspaceRole, resolveMembershipRole, workspacePages, roleLabels } = module.exports;
const access = (permissions = [], features = []) => ({ role: 'agent', permissions, features, superadmin: false });
test('UI fails closed until permissions arrive and rejects unknown routes', () => {
  for (const page of workspacePages.filter(page => !['Settings', 'Help & support'].includes(page))) assert.equal(canOpenPage(access(), page), false, page);
  assert.equal(canOpenPage(access(), 'Settings'), true);
  assert.equal(canOpenPage({ ...access(), superadmin: true }, 'Unknown'), false);
});
test('Agent receives customer work tools and no default business management access', () => {
  const agent = access(['overview.read','conversations.read','conversations.update','conversations.send','contacts.read','calls.read','templates.read'], ['conversations','contacts','calls','templates']);
  for (const page of ['Overview','Inbox','Contacts','Calls','Templates']) assert.equal(canOpenPage(agent,page),true,page);
  assert.equal(canOpenPage(agent,'Wallet'),false);
  for (const page of ['Team','Campaigns','Automations','Reports','Enterprise Analytics']) assert.equal(canOpenPage(agent,page),false,page);
  assert.equal(can(agent,'conversations.update'),true);
  assert.equal(can(agent,'conversations.send'),true);
  for (const capability of ['campaigns.send','team.manage','workspace.manage','integrations.manage']) assert.equal(can(agent,capability),false);
});
test('explicitly granted business features remain constrained by module availability; disabled modules override them', () => {
  const custom = { ...access(['campaigns.read','campaigns.send'],['campaigns']),customPermissions:true };
  assert.equal(canOpenPage(custom,'Campaigns'),true);
  assert.equal(can(custom,'campaigns.send'),true);
  assert.equal(canOpenPage({...custom,features:[]},'Campaigns'),false);
  assert.equal(can({...custom,role:'viewer'},'campaigns.send'),false);
  assert.equal(canOpenPage({...custom,role:'viewer'},'Campaigns'),false);
  assert.equal(canOpenPage({...custom,role:'viewer'},'Settings'),false);
  assert.equal(canOpenPage({...custom,superadmin:true,features:[]},'Campaigns'),true);
  assert.equal(new Set(Object.values(roleLabels)).size,3);
});
test('missing, retired, and invalid roles cannot silently become active memberships', () => {
  for (const role of ['owner','admin','agent','supervisor']) assert.equal(resolveWorkspaceRole(role),role);
  for (const unknown of [undefined,'','viewer','superadmin','invalid']) assert.equal(resolveWorkspaceRole(unknown),null);
});
test('verified business membership selects the dashboard independently of account role', () => {
  const members = [{user:{_id:'one',role:'owner'},role:'agent'},{user:{id:'two',role:'agent'},role:'admin'},{user:'retired',role:'viewer'}];
  assert.equal(resolveMembershipRole('admin',members,'one'),'admin');
  assert.equal(resolveMembershipRole(undefined,members,'one'),'agent');
  assert.equal(resolveMembershipRole(undefined,members,'two'),'admin');
  assert.equal(resolveMembershipRole('viewer',members,'one'),null);
  assert.equal(resolveMembershipRole(undefined,members,'retired'),null);
  assert.equal(resolveMembershipRole(undefined,[],'one'),null);
  assert.equal(resolveMembershipRole(undefined,members,'unknown'),null);
  assert.equal(resolveMembershipRole(undefined,[],'root',true),'owner');
});
