import test from 'node:test';
import assert from 'node:assert/strict';
import Workspace from '../models/Workspace.js';
import { CAPABILITIES, DEFAULT_PERMISSIONS, canCreateRole, membershipCapacityFilter, permissionsFor, validateRolePolicy, workspaceRolePolicy } from './accessControl.js';
import { assertActorPermission, assertCreationRole, validateBusinessRules } from './businessAccess.js';
import { assertLastAdmin, conversationScope } from './businessPolicy.js';
import { validateWorkspaceConfiguration } from './workspaceConfig.js';
test('existing workspaces retain restrictive defaults; Supervisor creation needs an explicit root choice',()=>{
  const policy=workspaceRolePolicy({});assert.deepEqual(policy.creatableRoles,['admin','agent']);
  assert.equal(canCreateRole({},'supervisor','admin'),false);assert.equal(canCreateRole({},'supervisor','superadmin'),true);
  for(const role of ['agent','supervisor'])for(const capability of ['wallet.read','integrations.manage','team.manage','campaigns.send','workspace.manage'])assert.ok(!permissionsFor({},{role},role).includes(capability));
  assert.ok(permissionsFor({},{role:'supervisor'},'supervisor').includes('overview.read'));
});
test('root ceilings allow explicit grants, business and individual rules cannot exceed them',()=>{
  const workspace={rolePolicy:{creatableRoles:['agent','supervisor'],permissionCeilings:[{role:'agent',permissions:['overview.read','wallet.read']},{role:'supervisor',permissions:['overview.read','team.read']}]},permissionRules:[{role:'agent',permissions:['overview.read','wallet.read','integrations.manage']}]};
  assert.deepEqual(permissionsFor(workspace,{role:'agent'},'agent'),['overview.read','wallet.read']);
  assert.deepEqual(permissionsFor(workspace,{role:'agent',customPermissions:['wallet.read','integrations.manage']},'agent'),['wallet.read']);
  assert.equal(validateBusinessRules(workspace,[{role:'agent',permissions:['wallet.read']}]),true);
  assert.equal(validateBusinessRules(workspace,[{role:'agent',permissions:['team.manage']}]),false);
  workspace.rolePolicy.permissionCeilings[0].permissions=[];assert.deepEqual(permissionsFor(workspace,{role:'agent',customPermissions:['wallet.read']},'agent'),[]);
  assert.deepEqual(permissionsFor(workspace,{role:'supervisor',disabled:true},'supervisor'),[]);
  assert.deepEqual(permissionsFor(workspace,{role:'retired',customPermissions:CAPABILITIES},'agent'),[]);
});
test('creation validation and transaction checks fail closed for unsupported roles and revoked grants',()=>{
  const policy={creatableRoles:['supervisor'],permissionCeilings:[{role:'supervisor',permissions:DEFAULT_PERMISSIONS.supervisor}]};
  assert.ok(validateRolePolicy(policy));for(const bad of [{...policy,creatableRoles:['superadmin']},{...policy,creatableRoles:['agent','agent']},{...policy,permissionCeilings:[{role:'owner',permissions:[]}]},{...policy,permissionCeilings:[{role:'supervisor',permissions:['root.manage']}]}])assert.equal(Boolean(validateRolePolicy(bad)),false);
  assert.throws(()=>assertCreationRole({rolePolicy:policy},'admin','admin'),/not allowed/);
  assert.throws(()=>assertActorPermission({}, {role:'agent'}, 'agent', 'team.manage'),/unavailable/);
  assert.throws(()=>assertActorPermission({}, {role:'admin',disabled:true}, 'admin', 'team.manage'),/unavailable/);
  const config=validateWorkspaceConfiguration({name:'Business',rolePolicy:policy});assert.deepEqual(config.rolePolicy,policy);assert.deepEqual(config.permissionRules,policy.permissionCeilings);
  const filter=membershipCapacityFilter('business','user','supervisor',{members:null},false,true);assert.deepEqual(filter.$expr.$and[1],{$in:['supervisor',{$ifNull:['$rolePolicy.creatableRoles',['admin','agent']]}]});
});
test('Supervisor reads and writes remain scoped to assigned teams and allowed numbers',()=>{
  const req={workspace:{_id:'business'},user:{_id:'supervisor',role:'supervisor'},membership:{role:'supervisor',teams:['support'],allowedNumbers:['number'],visibility:'assigned'}};
  for(const write of [false,true]){const filter=conversationScope(req,{write});assert.equal(filter.workspace,'business');assert.deepEqual(filter.$and[0].$or,[{assignedTo:'supervisor'},{team:{$in:['support']}}]);assert.deepEqual(filter.$and[1].$or,[{number:{$in:['number']}},{number:null}]);}
  req.membership.teams=[];assert.deepEqual(conversationScope(req).$and[0].$or,[{assignedTo:'supervisor'}]);
  assert.throws(()=>assertLastAdmin([{user:'admin',role:'admin'}],'admin',{role:'supervisor'}),/last active/);
});
test('legacy Viewer data is retired on save validation without additional permissions',async()=>{
  const workspace=new Workspace({name:'Business',slug:'business',owner:'507f1f77bcf86cd799439011',members:[{user:'507f1f77bcf86cd799439012',role:'viewer',disabled:false}],permissionRules:[{role:'viewer',permissions:['contacts.read']}]});
  await workspace.validate();assert.equal(workspace.members[0].role,'retired');assert.equal(workspace.members[0].disabled,true);assert.deepEqual(Array.from(workspace.permissionRules),[]);
});
